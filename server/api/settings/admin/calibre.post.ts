import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';

import { and, eq, sql } from 'drizzle-orm';
import { normalizePublishedAt } from '~~/server/utils/books/published';
import sharp from 'sharp';

import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  bookFiles,
  bookIdentifiers,
  bookTags,
  books,
  collectionBooks,
  collectionMembers,
  publishers,
  series,
  tags,
} from '~/utils/db/schema';
import {
  CalibreReader,
  type CalibreBookRow,
  type CalibreFormatFile,
} from '~~/server/utils/import/calibre/calibre-reader';
import { makeAuthorSortKey, makeTitleSortKey } from '~~/server/utils/sort/keys';

type Body = {
  /**
   * Action:
   * - "import": Import all books from Calibre `library/metadata.db` into Delb, idempotently.
   * - "rescan": Re-read Calibre `metadata.db` and refresh files/covers/metadata for previously imported books
   *   (and optionally import new books, controlled by `importNew`).
   */
  action: 'import' | 'rescan';

  /**
   * Target collections to add imported books into.
   * Required for the first import (same rule as uploads).
   * For rescan, this is optional; if omitted, we do not add to any new collections.
   */
  collectionIds?: string[];

  /**
   * In rescan mode:
   * - if true, import Calibre books not yet present in Delb (default: false)
   */
  importNew?: boolean;

  /**
   * If true, do not write to the Delb database. Returns a preview summary.
   * (Still reads Calibre metadata.db)
   */
  dryRun?: boolean;
};

type ImportSummary = {
  action: Body['action'];
  dryRun: boolean;
  libraryRoot: string;
  calibreDbPath: string;

  scanned: {
    // entity counts
    calibreBooks: number;
    calibreAuthors: number;
    calibreTags: number;
    calibrePublishers: number;
    calibreSeries: number;

    // link counts (join tables)
    calibreBookAuthorLinks: number;
    calibreBookTagLinks: number;
    calibreBookPublisherLinks: number;
    calibreBookSeriesLinks: number;

    // other
    calibreIdentifiers: number;
    calibreFormatFilesFromDb: number;
  };

  results: {
    booksCreated: number;
    booksUpdated: number;
    filesUpserted: number;
    authorsCreated: number;
    tagsCreated: number;
    publishersCreated: number;
    seriesCreated: number;
    identifiersUpserted: number;
    bookAuthorLinksUpserted: number;
    bookTagLinksUpserted: number;
    bookPublisherLinksUpserted: number;
    bookSeriesLinksUpserted: number;
    collectionLinksAdded: number;

    // housekeeping / soft errors
    coverCandidatesFound: number;
    coverPathsSet: number;
    bookPathsMissingInCalibre: number;
    filesDiscoveredByDirScan: number;
    warnings: string[];
  };
};

function normalizeFormat(input: string): string {
  return (input ?? '').toString().trim().toLowerCase();
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function safeNonEmptyString(v: unknown): string | null {
  const s = (v ?? '').toString().trim();
  return s.length > 0 ? s : null;
}

type EventWithHeaders = {
  headers: Headers | Record<string, string | string[] | undefined>;
};

function toHeadersInit(h: EventWithHeaders['headers']): HeadersInit {
  // `auth.api.getSession` expects `HeadersInit` (Fetch API).
  // Nitro's `event.headers` can be a `Headers` or a plain object.
  if (h instanceof Headers) return h;

  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(h)) {
    if (typeof value === 'string') {
      pairs.push([key, value]);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string') pairs.push([key, v]);
      }
    }
  }
  return pairs;
}

async function assertIsAdminOrOwner(event: EventWithHeaders) {
  const session = await auth.api.getSession({
    headers: toHeadersInit(event.headers),
  });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });

  const user = session.user;
  if (user.role !== 'admin' && user.role !== 'owner') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }

  return session;
}

/**
 * Ensure the user can add books to every target collection.
 * Mirrors the behavior in `/api/books/upload`.
 */
async function assertCanAddToCollections(opts: {
  userId: string;
  collectionIds: string[];
}) {
  const uniqueIds = uniq(opts.collectionIds).filter(Boolean);
  if (!uniqueIds.length) {
    throw createError({
      statusCode: 400,
      statusMessage: 'At least one target collection is required',
    });
  }

  const memberships = await cloudDb
    .select()
    .from(collectionMembers)
    .where(eq(collectionMembers.userId, opts.userId));

  const roleByCollectionId = new Map(
    memberships.map((m) => [m.collectionId, m.role] as const),
  );

  const forbidden = uniqueIds.filter((id) => {
    const role = roleByCollectionId.get(id);
    return role !== 'owner' && role !== 'editor';
  });

  if (forbidden.length) {
    throw createError({
      statusCode: 403,
      statusMessage:
        'You do not have permission to add books to one or more selected collections',
    });
  }
}

/**
 * Try to discover book format files on disk by scanning the book directory, when
 * Calibre DB doesn't provide file info (common).
 *
 * Returns Delb-style `library/<calibreRelDir>/<filename>` relative paths.
 */
async function scanBookDirForFormats(opts: {
  calibreBook: CalibreBookRow;
  libraryRootAbs: string;
}): Promise<CalibreFormatFile[]> {
  const relDir = safeNonEmptyString(opts.calibreBook.path);
  if (!relDir) return [];

  const dirAbs = path.resolve(opts.libraryRootAbs, relDir);

  try {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter(Boolean);

    const out: CalibreFormatFile[] = [];

    for (const filename of files) {
      // Skip the common Calibre sidecar files
      const lower = filename.toLowerCase();
      if (
        lower === 'metadata.opf' ||
        lower === 'cover.jpg' ||
        lower === 'cover.jpeg' ||
        lower === 'cover.png'
      ) {
        continue;
      }

      const ext = normalizeFormat(path.extname(filename).replace(/^\./, ''));
      if (!ext) continue;

      // Keep parity with `download.get.ts` supported formats (and upload modal list).
      // You can expand this later by supporting more formats in the app.
      const supported = ['epub', 'pdf', 'mobi', 'azw3'];
      if (!supported.includes(ext)) continue;

      out.push({
        calibreBookId: opts.calibreBook.calibreBookId,
        format: ext,
        // CalibreReader (libsql) returns paths relative to the library root.
        // Delb stores paths under `library/...`.
        relativePath: ['library', relDir, filename].join('/'),
      });
    }

    return out;
  } catch {
    return [];
  }
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const s = await stat(absPath);
    return s.isFile();
  } catch {
    return false;
  }
}

export default defineEventHandler(async (event) => {
  logger.debug('POST /api/settings/admin/calibre');

  const session = await assertIsAdminOrOwner(event);
  const userId = session.user.id;

  const body = (await readBody<Body>(event)) ?? ({} as Body);

  const action = body.action;
  if (action !== 'import' && action !== 'rescan') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing or invalid `action` (import|rescan)',
    });
  }

  const dryRun = !!body.dryRun;
  const importNew = !!body.importNew;

  // Calibre library is mounted at Delb's `library/` folder.
  const libraryRootAbs = path.resolve(process.cwd(), 'library');
  const calibreDbPathAbs = path.resolve(libraryRootAbs, 'metadata.db');

  // Collections:
  // - Required for import
  // - Optional for rescan
  const requestedCollectionIds = uniq(body.collectionIds ?? []).filter(Boolean);

  if (action === 'import') {
    await assertCanAddToCollections({
      userId,
      collectionIds: requestedCollectionIds,
    });
  }

  const reader = new CalibreReader({ libraryRootAbs, readonly: true });

  try {
    const snap = await reader.getSnapshot();

    const summary: ImportSummary = {
      action,
      dryRun,
      libraryRoot: 'library',
      calibreDbPath: 'library/metadata.db',
      scanned: {
        // entity counts
        calibreBooks: snap.books.length,
        calibreAuthors: snap.authors.length,
        calibreTags: snap.tags.length,
        calibrePublishers: snap.publishers.length,
        calibreSeries: snap.series.length,

        // link counts (join tables)
        calibreBookAuthorLinks: snap.bookAuthors.length,
        calibreBookTagLinks: snap.bookTags.length,
        calibreBookPublisherLinks: snap.bookPublishers.length,
        calibreBookSeriesLinks: snap.bookSeries.length,

        // other
        calibreIdentifiers: snap.identifiers.length,
        calibreFormatFilesFromDb: snap.formatFiles.length,
      },
      results: {
        booksCreated: 0,
        booksUpdated: 0,
        filesUpserted: 0,
        authorsCreated: 0,
        tagsCreated: 0,
        publishersCreated: 0,
        seriesCreated: 0,
        identifiersUpserted: 0,
        bookAuthorLinksUpserted: 0,
        bookTagLinksUpserted: 0,
        bookPublisherLinksUpserted: 0,
        bookSeriesLinksUpserted: 0,
        collectionLinksAdded: 0,
        coverCandidatesFound: 0,
        coverPathsSet: 0,
        bookPathsMissingInCalibre: 0,
        filesDiscoveredByDirScan: 0,
        warnings: [],
      },
    };

    // ---- Build lookup maps from Calibre snapshot ----
    const calibreAuthorById = new Map(
      snap.authors.map((a) => [a.calibreAuthorId, a]),
    );
    const calibreTagById = new Map(snap.tags.map((t) => [t.calibreTagId, t]));
    const calibrePublisherById = new Map(
      snap.publishers.map((p) => [p.calibrePublisherId, p]),
    );
    const calibreSeriesById = new Map(
      snap.series.map((s) => [s.calibreSeriesId, s]),
    );

    const calibreAuthorsByBookId = new Map<number, number[]>();
    for (const link of snap.bookAuthors) {
      const list = calibreAuthorsByBookId.get(link.calibreBookId) ?? [];
      list.push(link.calibreAuthorId);
      calibreAuthorsByBookId.set(link.calibreBookId, list);
    }

    const calibreTagsByBookId = new Map<number, number[]>();
    for (const link of snap.bookTags) {
      const list = calibreTagsByBookId.get(link.calibreBookId) ?? [];
      list.push(link.calibreTagId);
      calibreTagsByBookId.set(link.calibreBookId, list);
    }

    const calibrePublisherByBookId = new Map<number, number>();
    for (const link of snap.bookPublishers) {
      calibrePublisherByBookId.set(link.calibreBookId, link.calibrePublisherId);
    }

    const calibreSeriesByBookId = new Map<number, number>();
    for (const link of snap.bookSeries) {
      calibreSeriesByBookId.set(link.calibreBookId, link.calibreSeriesId);
    }

    const calibreCommentByBookId = new Map<number, string>();
    for (const c of snap.comments) {
      if (!c.text) continue;
      calibreCommentByBookId.set(c.calibreBookId, c.text);
    }

    const calibreIdentifiersByBookId = new Map<
      number,
      Array<{ type: string; value: string }>
    >();
    for (const ident of snap.identifiers) {
      const list = calibreIdentifiersByBookId.get(ident.calibreBookId) ?? [];
      list.push({ type: ident.type, value: ident.value });
      calibreIdentifiersByBookId.set(ident.calibreBookId, list);
    }

    const calibreLanguagesByBookId = new Map<number, string[]>();
    for (const lang of snap.languages) {
      const list = calibreLanguagesByBookId.get(lang.calibreBookId) ?? [];
      list.push(lang.langCode);
      calibreLanguagesByBookId.set(lang.calibreBookId, list);
    }

    const calibreFormatFilesByBookId = new Map<number, CalibreFormatFile[]>();
    for (const f of snap.formatFiles) {
      const list = calibreFormatFilesByBookId.get(f.calibreBookId) ?? [];
      list.push(f);
      calibreFormatFilesByBookId.set(f.calibreBookId, list);
    }

    // ---- Load existing Delb books keyed by calibreBookId (for idempotency) ----
    const existing = await cloudDb
      .select({ id: books.id, calibreBookId: books.calibreBookId })
      .from(books)
      .where(sql`${books.calibreBookId} IS NOT NULL`);

    const delbBookIdByCalibreBookId = new Map<number, string>();
    for (const row of existing) {
      if (typeof row.calibreBookId === 'number') {
        delbBookIdByCalibreBookId.set(row.calibreBookId, row.id);
      }
    }

    // ---- Helpers to upsert name-based entities ----
    //
    // Important: In dry-run mode, nothing is written to the DB. Without an in-memory
    // cache, we'd "create" the same name repeatedly (because future lookups won't
    // find rows that would have been inserted).
    //
    // These caches make dry-run "created" counts reflect unique entities that would exist
    // after the import, not the number of link occurrences.
    const authorIdByName = new Map<string, string>();
    const tagIdByName = new Map<string, string>();
    const publisherIdByName = new Map<string, string>();
    const seriesIdByName = new Map<string, string>();

    async function upsertAuthorByName(
      name: string,
      sortName?: string | null,
    ): Promise<string> {
      const trimmed = (name ?? '').toString().trim();
      if (!trimmed) return '00000000-0000-0000-0000-000000000000'; // should never be used

      const cached = authorIdByName.get(trimmed);
      if (cached) return cached;

      const found = await cloudDb
        .select()
        .from(authors)
        .where(eq(authors.name, trimmed))
        .limit(1);
      if (found[0]?.id) {
        authorIdByName.set(trimmed, found[0].id);
        return found[0].id;
      }

      const id = crypto.randomUUID();
      const now = new Date();

      if (!dryRun) {
        await cloudDb.insert(authors).values({
          id,
          name: trimmed,
          sortName: sortName?.toString() || makeAuthorSortKey(trimmed),
          createdAt: now,
          updatedAt: now,
        });
      }

      authorIdByName.set(trimmed, id);
      summary.results.authorsCreated += 1;
      return id;
    }

    async function upsertTagByName(name: string): Promise<string> {
      const trimmed = (name ?? '').toString().trim();
      if (!trimmed) return '00000000-0000-0000-0000-000000000000'; // should never be used

      const cached = tagIdByName.get(trimmed);
      if (cached) return cached;

      const found = await cloudDb
        .select()
        .from(tags)
        .where(eq(tags.name, trimmed))
        .limit(1);
      if (found[0]?.id) {
        tagIdByName.set(trimmed, found[0].id);
        return found[0].id;
      }

      const id = crypto.randomUUID();
      const now = new Date();

      if (!dryRun) {
        await cloudDb.insert(tags).values({
          id,
          name: trimmed,
          createdAt: now,
          updatedAt: now,
        });
      }

      tagIdByName.set(trimmed, id);
      summary.results.tagsCreated += 1;
      return id;
    }

    async function upsertPublisherByName(name: string): Promise<string> {
      const trimmed = (name ?? '').toString().trim();
      if (!trimmed) return '00000000-0000-0000-0000-000000000000'; // should never be used

      const cached = publisherIdByName.get(trimmed);
      if (cached) return cached;

      const found = await cloudDb
        .select()
        .from(publishers)
        .where(eq(publishers.name, trimmed))
        .limit(1);
      if (found[0]?.id) {
        publisherIdByName.set(trimmed, found[0].id);
        return found[0].id;
      }

      const id = crypto.randomUUID();
      const now = new Date();

      if (!dryRun) {
        await cloudDb.insert(publishers).values({
          id,
          name: trimmed,
          createdAt: now,
          updatedAt: now,
        });
      }

      publisherIdByName.set(trimmed, id);
      summary.results.publishersCreated += 1;
      return id;
    }

    async function upsertSeriesByName(name: string): Promise<string> {
      const trimmed = (name ?? '').toString().trim();
      if (!trimmed) return '00000000-0000-0000-0000-000000000000'; // should never be used

      const cached = seriesIdByName.get(trimmed);
      if (cached) return cached;

      const found = await cloudDb
        .select()
        .from(series)
        .where(eq(series.name, trimmed))
        .limit(1);
      if (found[0]?.id) {
        seriesIdByName.set(trimmed, found[0].id);
        return found[0].id;
      }

      const id = crypto.randomUUID();
      const now = new Date();

      if (!dryRun) {
        await cloudDb.insert(series).values({
          id,
          name: trimmed,
          createdAt: now,
          updatedAt: now,
        });
      }

      seriesIdByName.set(trimmed, id);
      summary.results.seriesCreated += 1;
      return id;
    }

    // ---- Import / Rescan loop ----
    for (const calibreBook of snap.books) {
      if (!calibreBook.calibreBookId || calibreBook.calibreBookId <= 0)
        continue;

      const knownDelbBookId = delbBookIdByCalibreBookId.get(
        calibreBook.calibreBookId,
      );

      if (action === 'rescan' && !knownDelbBookId && !importNew) {
        continue;
      }

      const hasCalibrePath = safeNonEmptyString(calibreBook.path) !== null;
      if (!hasCalibrePath) summary.results.bookPathsMissingInCalibre += 1;

      // Authors (Calibre -> Delb)
      const calibreAuthorIds = uniq(
        calibreAuthorsByBookId.get(calibreBook.calibreBookId) ?? [],
      );
      const authorNames = calibreAuthorIds
        .map((id) => calibreAuthorById.get(id)?.name)
        .filter((n): n is string => !!safeNonEmptyString(n))
        .map((n) => n.trim());

      const effectiveAuthorNames = authorNames.length
        ? authorNames
        : ['Unknown Author'];

      // Create/book upsert
      const now = new Date();
      let delbBookId = knownDelbBookId ?? null;

      // Publisher/Series (optional)
      const calibrePublisherId = calibrePublisherByBookId.get(
        calibreBook.calibreBookId,
      );
      const calibreSeriesId = calibreSeriesByBookId.get(
        calibreBook.calibreBookId,
      );

      const publisherName = calibrePublisherId
        ? (calibrePublisherById.get(calibrePublisherId)?.name ?? null)
        : null;
      const seriesName = calibreSeriesId
        ? (calibreSeriesById.get(calibreSeriesId)?.name ?? null)
        : null;

      const publisherId = publisherName
        ? await upsertPublisherByName(publisherName)
        : null;
      const seriesId = seriesName ? await upsertSeriesByName(seriesName) : null;

      const description =
        calibreCommentByBookId.get(calibreBook.calibreBookId) ?? null;

      const languageCodes =
        calibreLanguagesByBookId.get(calibreBook.calibreBookId) ?? [];
      const language = languageCodes.length ? languageCodes[0]! : null;

      const published =
        safeNonEmptyString(calibreBook.pubdate) ??
        safeNonEmptyString(calibreBook.timestamp) ??
        null;

      const publishedAt = published ? normalizePublishedAt(published) : null;

      // Cover:
      // - Calibre typically stores a full-res `cover.jpg/png` in the book directory.
      // - Delb should use a lightweight `thumb.webp` almost everywhere, and only serve
      //   the full-res source on demand.
      //
      // Policy here:
      // - If a Calibre cover exists, generate/ensure `thumb.webp` next to it (idempotent).
      // - Store `books.coverImagePath` as the thumbnail path (`library/<dir>/thumb.webp`).
      let coverImagePath: string | null = null;
      const coverCandidates = reader.getCoverCandidates(calibreBook);
      summary.results.coverCandidatesFound += coverCandidates.length;

      for (const c of coverCandidates) {
        if (await fileExists(c.absPath)) {
          const relDir = (calibreBook.path ?? '').toString().trim();
          if (!relDir) break;

          const bookDirAbs = reader.resolveBookDirAbs(calibreBook);
          if (!bookDirAbs) break;

          const thumbAbs = path.resolve(bookDirAbs, 'thumb.webp');
          const thumbRelPosix = ['library', relDir, 'thumb.webp'].join('/');

          // Generate thumb only if it doesn't already exist (keeps imports fast on re-scan)
          if (!(await fileExists(thumbAbs))) {
            try {
              const { readFile, writeFile } = await import('node:fs/promises');
              const srcBytes = await readFile(c.absPath);

              const thumbBytes = await sharp(srcBytes)
                .rotate()
                .resize({ width: 320, withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();

              await writeFile(thumbAbs, thumbBytes);
            } catch (e) {
              // If thumbnail generation fails, fall back to pointing at the original cover
              // (still correct, just heavier).
              logger.warn(
                e,
                'calibre import: failed to generate thumb.webp; falling back to source cover path',
              );
              coverImagePath = c.relativePath;
              break;
            }
          }

          coverImagePath = thumbRelPosix;
          break;
        }
      }

      if (knownDelbBookId) {
        // Update
        if (!dryRun) {
          await cloudDb
            .update(books)
            .set({
              title: calibreBook.title || 'Unknown',
              sortTitle:
                safeNonEmptyString(calibreBook.sort) ??
                makeTitleSortKey(calibreBook.title || ''),
              description,
              language,
              published,
              publishedAt,
              publisherId,
              seriesId,
              seriesIndex:
                typeof calibreBook.seriesIndex === 'number'
                  ? calibreBook.seriesIndex
                  : null,
              coverImagePath,
              updatedAt: now,
              calibreBookId: calibreBook.calibreBookId,
            })
            .where(eq(books.id, knownDelbBookId));
        }
        summary.results.booksUpdated += 1;
        delbBookId = knownDelbBookId;
      } else {
        // Create
        const newId = crypto.randomUUID();
        if (!dryRun) {
          await cloudDb.insert(books).values({
            id: newId,
            title: calibreBook.title || 'Unknown',
            sortTitle:
              safeNonEmptyString(calibreBook.sort) ??
              makeTitleSortKey(calibreBook.title || ''),
            description,
            language,
            published,
            publishedAt,
            publisherId,
            seriesId,
            seriesIndex:
              typeof calibreBook.seriesIndex === 'number'
                ? calibreBook.seriesIndex
                : null,
            coverImagePath,
            createdByUserId: userId,
            createdAt: now,
            updatedAt: now,
            calibreBookId: calibreBook.calibreBookId,
          });
        }
        summary.results.booksCreated += 1;
        delbBookId = newId;
        delbBookIdByCalibreBookId.set(calibreBook.calibreBookId, newId);
      }

      if (!delbBookId) continue;

      if (coverImagePath) summary.results.coverPathsSet += 1;

      // Upsert author entities and book-author links (position order)
      const delbAuthorIds: string[] = [];
      for (const [i, name] of effectiveAuthorNames.entries()) {
        const calibreAuthor = calibreAuthorById.get(calibreAuthorIds[i] ?? -1);
        const aId = await upsertAuthorByName(name, calibreAuthor?.sort ?? null);
        delbAuthorIds.push(aId);

        if (!dryRun) {
          await cloudDb
            .insert(bookAuthors)
            .values({ bookId: delbBookId, authorId: aId, position: i + 1 })
            .onConflictDoNothing();
        }
        summary.results.bookAuthorLinksUpserted += 1;
      }

      // Tags
      const calibreTagIds = uniq(
        calibreTagsByBookId.get(calibreBook.calibreBookId) ?? [],
      );
      for (const tagId of calibreTagIds) {
        const tagName = calibreTagById.get(tagId)?.name;
        if (!tagName) continue;

        const tId = await upsertTagByName(tagName);

        if (!dryRun) {
          await cloudDb
            .insert(bookTags)
            .values({ bookId: delbBookId, tagId: tId })
            .onConflictDoNothing();
        }
        summary.results.bookTagLinksUpserted += 1;
      }

      // Publisher link (books.publisherId is the link in Delb)
      if (publisherId) {
        summary.results.bookPublisherLinksUpserted += 1;
      }

      // Series link (books.seriesId is the link in Delb)
      if (seriesId) {
        summary.results.bookSeriesLinksUpserted += 1;
      }

      // Identifiers
      const identifiers =
        calibreIdentifiersByBookId.get(calibreBook.calibreBookId) ?? [];
      for (const ident of identifiers) {
        const type = normalizeFormat(ident.type);
        const value = (ident.value ?? '').toString().trim();
        if (!type || !value) continue;

        if (!dryRun) {
          await cloudDb
            .insert(bookIdentifiers)
            .values({ bookId: delbBookId, type, value })
            .onConflictDoUpdate({
              target: [bookIdentifiers.bookId, bookIdentifiers.type],
              set: { value: sql`EXCLUDED.value` },
            });
        }
        summary.results.identifiersUpserted += 1;
      }

      // Files: from DB (if available) OR scan directory
      let formatFiles =
        calibreFormatFilesByBookId.get(calibreBook.calibreBookId) ?? [];
      if (!formatFiles.length) {
        const scanned = await scanBookDirForFormats({
          calibreBook,
          libraryRootAbs,
        });
        if (scanned.length) {
          summary.results.filesDiscoveredByDirScan += scanned.length;
          formatFiles = scanned;
        }
      }

      for (const f of formatFiles) {
        const format = normalizeFormat(f.format);
        if (!format) continue;

        const rawRelativePath = safeNonEmptyString(f.relativePath);
        if (!rawRelativePath) continue;

        // CalibreReader returns paths relative to the Calibre library root (e.g. "Author/Title (1)/Book.epub").
        // Delb stores paths under `library/...`.
        const relativePath = rawRelativePath.startsWith('library/')
          ? rawRelativePath
          : ['library', rawRelativePath].join('/');

        // We only store paths under `library/...`. The download endpoint protects traversal.
        if (!relativePath.startsWith('library/')) {
          summary.results.warnings.push(
            `Skipping non-library path for calibreBookId=${calibreBook.calibreBookId}: ${relativePath}`,
          );
          continue;
        }

        if (!dryRun) {
          // Upsert, keyed by (bookId, format, relativePath) isn't enforced; we just avoid duplicates by checking
          // existing rows quickly per book+format+path.
          const existingFile = await cloudDb
            .select({ id: bookFiles.id })
            .from(bookFiles)
            .where(
              and(
                eq(bookFiles.bookId, delbBookId),
                eq(bookFiles.format, format),
                eq(bookFiles.relativePath, relativePath),
              ),
            )
            .limit(1);

          if (!existingFile[0]?.id) {
            await cloudDb.insert(bookFiles).values({
              id: crypto.randomUUID(),
              bookId: delbBookId,
              format,
              relativePath,
              createdAt: now,
            });
            summary.results.filesUpserted += 1;
          }
        } else {
          summary.results.filesUpserted += 1;
        }
      }

      // Collections: add only if requested (import requires; rescan optional)
      if (requestedCollectionIds.length) {
        if (action === 'import') {
          // Validate permission (already did once) and add.
          for (const collectionId of requestedCollectionIds) {
            if (!dryRun) {
              // Avoid duplicates by checking existence.
              const existingLink = await cloudDb
                .select({ collectionId: collectionBooks.collectionId })
                .from(collectionBooks)
                .where(
                  and(
                    eq(collectionBooks.collectionId, collectionId),
                    eq(collectionBooks.bookId, delbBookId),
                  ),
                )
                .limit(1);

              if (!existingLink[0]?.collectionId) {
                await cloudDb.insert(collectionBooks).values({
                  collectionId,
                  bookId: delbBookId,
                  addedByUserId: userId,
                  addedAt: now,
                });
                summary.results.collectionLinksAdded += 1;
              }
            } else {
              summary.results.collectionLinksAdded += 1;
            }
          }
        } else if (action === 'rescan') {
          // Rescan: if collectionIds provided, add books to those collections too.
          // (No permission check unless collectionIds provided.)
          await assertCanAddToCollections({
            userId,
            collectionIds: requestedCollectionIds,
          });

          for (const collectionId of requestedCollectionIds) {
            if (!dryRun) {
              const existingLink = await cloudDb
                .select({ collectionId: collectionBooks.collectionId })
                .from(collectionBooks)
                .where(
                  and(
                    eq(collectionBooks.collectionId, collectionId),
                    eq(collectionBooks.bookId, delbBookId),
                  ),
                )
                .limit(1);

              if (!existingLink[0]?.collectionId) {
                await cloudDb.insert(collectionBooks).values({
                  collectionId,
                  bookId: delbBookId,
                  addedByUserId: userId,
                  addedAt: now,
                });
                summary.results.collectionLinksAdded += 1;
              }
            } else {
              summary.results.collectionLinksAdded += 1;
            }
          }
        }
      }
    }

    // Light sanity warnings for missing DB / common mount mistakes
    if (!(await reader.hasTable('books'))) {
      summary.results.warnings.push(
        'Calibre DB missing `books` table (unexpected).',
      );
    }
    if (
      calibreDbPathAbs !== path.resolve(process.cwd(), summary.calibreDbPath)
    ) {
      // never happens, but keeps the summary aligned
    }

    return { success: true, data: summary };
  } finally {
    await reader.close();
  }
});
