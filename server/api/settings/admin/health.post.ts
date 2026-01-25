import path from 'node:path';
import { stat } from 'node:fs/promises';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  bookFiles,
  bookIdentifiers,
  books,
  collectionBooks,
  collections,
  users,
} from '~/utils/db/schema';
import { BOOK_STORAGE_DEFAULTS } from '~~/server/utils/books/storage/paths';
import {
  FUZZY_DUPLICATE_THRESHOLD,
  fuzzySeedToken,
  fuzzyTitleAuthorScoreFromTokens,
  fuzzyTokens,
} from '~~/server/utils/books/duplicates';

type HealthMode = 'quick' | 'deep';
type HealthStatus = 'ok' | 'warn' | 'error';

type HealthCheckResult = {
  id: string;
  name: string;
  status: HealthStatus;
  message: string;
  howToFix?: string;
  meta?: Record<string, unknown>;
  sample?: Array<Record<string, unknown>>;
};

type Body = {
  mode?: unknown;
  sampleLimit?: unknown;
  maxFilesToStat?: unknown;
  maxDirsToStat?: unknown;
  maxBooksForFuzzy?: unknown;
  maxFuzzyComparisons?: unknown;
};

function normalizeInt(
  v: unknown,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  const n = typeof v === 'number' ? v : Number(v);
  const out = Number.isFinite(n) ? Math.floor(n) : fallback;
  const min = opts?.min ?? Number.NEGATIVE_INFINITY;
  const max = opts?.max ?? Number.POSITIVE_INFINITY;
  return Math.max(min, Math.min(max, out));
}

function worstStatus(a: HealthStatus, b: HealthStatus): HealthStatus {
  const rank: Record<HealthStatus, number> = { ok: 0, warn: 1, error: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function dirnamePosix(posixPath: string): string {
  const parts = (posixPath ?? '').split('/').filter((p) => p.length > 0);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

function resolveStoredPathUnderLibrary(storedPosixPath: string): {
  libraryBaseAbs: string;
  abs: string;
  relFromLibraryPosix: string;
} {
  const libraryBaseAbs = path.resolve(
    process.cwd(),
    BOOK_STORAGE_DEFAULTS.baseDir,
  );

  const relFromLibraryPosix = (storedPosixPath ?? '')
    .toString()
    .trim()
    .replace(/^library[\\/]/, '');

  const abs = path.resolve(libraryBaseAbs, relFromLibraryPosix.split('/').join(path.sep));

  const relToBase = path.relative(libraryBaseAbs, abs);
  if (relToBase.startsWith('..') || relToBase.includes(`..${path.sep}`)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' });
  }

  return { libraryBaseAbs, abs, relFromLibraryPosix };
}

async function existsFile(absPath: string): Promise<boolean> {
  try {
    const st = await stat(absPath);
    return st.isFile();
  } catch {
    return false;
  }
}

async function existsDir(absPath: string): Promise<boolean> {
  try {
    const st = await stat(absPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

const COVER_CANDIDATES = [
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'cover.webp',
  'cover.gif',
  'cover.svg',
  'cover.avif',
  'cover.tif',
  'cover.tiff',
  'cover.source.jpg',
  'cover.source.jpeg',
  'cover.source.png',
  'cover.source.webp',
  'source.jpg',
  'source.jpeg',
  'source.png',
  'source.webp',
] as const;

export default defineEventHandler(async (event) => {
  logger.debug('POST /api/settings/admin/health');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const user = session.user;
  if (user.role !== 'admin' && user.role !== 'owner') {
    setResponseStatus(event, 403);
    return { success: false, message: 'Forbidden' };
  }

  const body = await readBody<Body>(event);
  const mode: HealthMode =
    typeof body?.mode === 'string' && body.mode.trim().toLowerCase() === 'deep'
      ? 'deep'
      : 'quick';

  const sampleLimit = normalizeInt(body?.sampleLimit, 20, { min: 0, max: 100 });
  const maxFilesToStat = normalizeInt(body?.maxFilesToStat, 5000, {
    min: 0,
    max: 50_000,
  });
  const maxDirsToStat = normalizeInt(body?.maxDirsToStat, 5000, {
    min: 0,
    max: 50_000,
  });
  const maxBooksForFuzzy = normalizeInt(body?.maxBooksForFuzzy, 3000, {
    min: 0,
    max: 20_000,
  });
  const maxFuzzyComparisons = normalizeInt(body?.maxFuzzyComparisons, 150_000, {
    min: 0,
    max: 2_000_000,
  });

  const startedAt = new Date().toISOString();

  const results: HealthCheckResult[] = [];

  // 1) Orphaned books (no collection link)
  {
    const countRows = await cloudDb
      .select({ n: sql<number>`COUNT(*)` })
      .from(books)
      .leftJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
      .where(sql`${collectionBooks.bookId} IS NULL`);

    const orphanCount = countRows?.[0]?.n ?? 0;

    const sample =
      sampleLimit > 0 && orphanCount > 0
        ? await cloudDb
            .select({ id: books.id, title: books.title })
            .from(books)
            .leftJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
            .where(sql`${collectionBooks.bookId} IS NULL`)
            .limit(sampleLimit)
        : [];

    results.push({
      id: 'books.orphaned',
      name: 'Orphaned books (no collection)',
      status: orphanCount > 0 ? 'warn' : 'ok',
      message:
        orphanCount > 0
          ? `${orphanCount} book(s) are not in any collection`
          : 'All books are linked to at least one collection',
      howToFix:
        orphanCount > 0
          ? 'Add each orphaned book to a collection (typically Personal) or delete the orphaned record.'
          : undefined,
      meta: { orphanCount },
      sample: sample.map((r) => ({ id: r.id, title: r.title })),
    });
  }

  // 2) Empty titles
  {
    const countRows = await cloudDb
      .select({ n: sql<number>`COUNT(*)` })
      .from(books)
      .where(sql`TRIM(${books.title}) = ''`);

    const emptyCount = countRows?.[0]?.n ?? 0;

    const sample =
      sampleLimit > 0 && emptyCount > 0
        ? await cloudDb
            .select({ id: books.id })
            .from(books)
            .where(sql`TRIM(${books.title}) = ''`)
            .limit(sampleLimit)
        : [];

    results.push({
      id: 'books.empty-title',
      name: 'Empty book titles',
      status: emptyCount > 0 ? 'error' : 'ok',
      message:
        emptyCount > 0
          ? `${emptyCount} book(s) have an empty title`
          : 'No books with empty titles found',
      howToFix:
        emptyCount > 0
          ? 'Edit the book title (or delete the record if it is junk).'
          : undefined,
      meta: { emptyCount },
      sample: sample.map((r) => ({ id: r.id })),
    });
  }

  // 3) Duplicate identifiers across books
  {
    // Keep this intentionally simple and portable across drizzle driver quirks:
    // group in SQL, then filter in JS.
    const grouped = await cloudDb
      .select({
        type: bookIdentifiers.type,
        value: bookIdentifiers.value,
        bookCount: sql<number>`COUNT(DISTINCT ${bookIdentifiers.bookId})`,
      })
      .from(bookIdentifiers)
      .groupBy(bookIdentifiers.type, bookIdentifiers.value);

    const dupRows = grouped.filter((r) => (r.bookCount ?? 0) > 1);

    const duplicateGroupCount = dupRows.length;
    const sample = sampleLimit > 0 ? dupRows.slice(0, sampleLimit) : [];

    results.push({
      id: 'identifiers.duplicates',
      name: 'Duplicate identifiers (type/value)',
      status: duplicateGroupCount > 0 ? 'warn' : 'ok',
      message:
        duplicateGroupCount > 0
          ? `${duplicateGroupCount} identifier value(s) are used by multiple books`
          : 'No duplicate identifiers found',
      howToFix:
        duplicateGroupCount > 0
          ? 'Review the referenced books and decide whether to keep both, merge, or remove incorrect identifiers.'
          : undefined,
      meta: { duplicateGroupCount },
      sample: sample.map((r) => ({
        type: r.type,
        value: r.value,
        bookCount: r.bookCount,
      })),
    });
  }

  // 4) Users missing a Personal collection
  {
    const countRows = await cloudDb
      .select({ n: sql<number>`COUNT(*)` })
      .from(users)
      .leftJoin(
        collections,
        and(eq(collections.ownerUserId, users.id), eq(collections.isPersonal, true)),
      )
      .where(sql`${collections.id} IS NULL`);

    const missingCount = countRows?.[0]?.n ?? 0;

    const sample =
      sampleLimit > 0 && missingCount > 0
        ? await cloudDb
            .select({ userId: users.id, email: users.email })
            .from(users)
            .leftJoin(
              collections,
              and(
                eq(collections.ownerUserId, users.id),
                eq(collections.isPersonal, true),
              ),
            )
            .where(sql`${collections.id} IS NULL`)
            .limit(sampleLimit)
        : [];

    results.push({
      id: 'users.missing-personal-collection',
      name: 'Users missing Personal collection',
      status: missingCount > 0 ? 'warn' : 'ok',
      message:
        missingCount > 0
          ? `${missingCount} user(s) do not have a Personal collection`
          : 'All users have a Personal collection',
      howToFix:
        missingCount > 0
          ? 'Create a Personal collection for each affected user (and ensure it is marked isPersonal=true).'
          : undefined,
      meta: { missingCount },
      sample: sample.map((r) => ({ userId: r.userId, email: r.email })),
    });
  }

  if (mode === 'deep') {
    // 4.5) Possible duplicates (same fuzzy check as ingest)
    {
      type BookRow = {
        id: string;
        title: string;
        coverImagePath: string | null;
        createdAt: unknown;
        createdByUserId: string | null;
      };

      const bookRows: BookRow[] =
        maxBooksForFuzzy > 0
          ? await cloudDb
              .select({
                id: books.id,
                title: books.title,
                coverImagePath: books.coverImagePath,
                createdAt: books.createdAt,
                createdByUserId: books.createdByUserId,
              })
              .from(books)
              .limit(maxBooksForFuzzy)
          : [];

      const bookIds = bookRows.map((b) => b.id).filter(Boolean);

      const authorLinks =
        bookIds.length > 0
          ? await cloudDb
              .select({
                bookId: bookAuthors.bookId,
                name: authors.name,
                position: bookAuthors.position,
              })
              .from(bookAuthors)
              .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
              .where(inArray(bookAuthors.bookId, bookIds))
              .orderBy(
                sql`COALESCE(${bookAuthors.position}, 999) ASC`,
                authors.name,
              )
          : [];

      const authorNamesByBookId = new Map<string, string[]>();
      for (const row of authorLinks) {
        const list = authorNamesByBookId.get(row.bookId) ?? [];
        list.push(row.name);
        authorNamesByBookId.set(row.bookId, list);
      }

      type Sig = {
        id: string;
        title: string;
        coverImagePath: string | null;
        createdAt: unknown;
        createdByUserId: string | null;
        authorNames: string[];
        titleTokens: string[];
        authorTokens: string[];
        seed: string | null;
      };

      const sigs: Sig[] = bookRows.map((b) => {
        const authorNames = authorNamesByBookId.get(b.id) ?? [];
        const titleTokens = fuzzyTokens(b.title);
        const authorTokens = fuzzyTokens(authorNames.join(' '));
        const seed = fuzzySeedToken(titleTokens);
        return {
          id: b.id,
          title: b.title,
          coverImagePath: b.coverImagePath ?? null,
          createdAt: b.createdAt,
          createdByUserId: b.createdByUserId ?? null,
          authorNames,
          titleTokens,
          authorTokens,
          seed,
        };
      });

      const bySeed = new Map<string, Sig[]>();
      for (const s of sigs) {
        if (!s.seed) continue;
        const list = bySeed.get(s.seed) ?? [];
        list.push(s);
        bySeed.set(s.seed, list);
      }

      let comparisons = 0;
      let foundPairs = 0;
      const samplePairs: Array<Record<string, unknown>> = [];

      const seenPairKey = new Set<string>();

      for (const [, bucket] of bySeed) {
        if (comparisons >= maxFuzzyComparisons) break;
        if (bucket.length < 2) continue;

        for (let i = 0; i < bucket.length; i++) {
          if (comparisons >= maxFuzzyComparisons) break;
          const a = bucket[i]!;
          for (let j = i + 1; j < bucket.length; j++) {
            if (comparisons >= maxFuzzyComparisons) break;
            const b = bucket[j]!;

            comparisons++;

            const score = fuzzyTitleAuthorScoreFromTokens({
              titleTokensA: a.titleTokens,
              authorTokensA: a.authorTokens,
              titleTokensB: b.titleTokens,
              authorTokensB: b.authorTokens,
            });

            if (score < FUZZY_DUPLICATE_THRESHOLD) continue;

            const first = a.id < b.id ? a : b;
            const second = a.id < b.id ? b : a;

            const aId = first.id;
            const bId = second.id;
            const key = `${aId}|${bId}`;
            if (seenPairKey.has(key)) continue;
            seenPairKey.add(key);

            foundPairs++;

            if (samplePairs.length < sampleLimit) {
              samplePairs.push({
                score,
                a: {
                  id: first.id,
                  title: first.title,
                  authorNames: first.authorNames,
                  coverImagePath: first.coverImagePath,
                  createdAt: first.createdAt,
                  ownerUserId: first.createdByUserId,
                },
                b: {
                  id: second.id,
                  title: second.title,
                  authorNames: second.authorNames,
                  coverImagePath: second.coverImagePath,
                  createdAt: second.createdAt,
                  ownerUserId: second.createdByUserId,
                },
              });
            }
          }
        }
      }

      // Enrich sample pairs with owner + collections info (bounded by sampleLimit).
      try {
        const ids = Array.from(
          new Set(
            samplePairs
              .flatMap((p) => [
                (p as { a?: { id?: unknown } }).a?.id,
                (p as { b?: { id?: unknown } }).b?.id,
              ])
              .map((x) => (x ?? '').toString())
              .filter(Boolean),
          ),
        );

        if (ids.length) {
          const ownerRows = await cloudDb
            .select({
              bookId: books.id,
              ownerUserId: books.createdByUserId,
              ownerName: users.name,
              ownerEmail: users.email,
            })
            .from(books)
            .leftJoin(users, eq(users.id, books.createdByUserId))
            .where(inArray(books.id, ids));

          const ownerByBookId = new Map(
            ownerRows.map((r) => [
              r.bookId,
              {
                userId: r.ownerUserId ?? null,
                name: r.ownerName ?? null,
                email: r.ownerEmail ?? null,
              },
            ]),
          );

          const collectionRows = await cloudDb
            .select({
              bookId: collectionBooks.bookId,
              id: collections.id,
              name: collections.name,
              isPersonal: collections.isPersonal,
            })
            .from(collectionBooks)
            .innerJoin(collections, eq(collections.id, collectionBooks.collectionId))
            .where(inArray(collectionBooks.bookId, ids));

          const collectionsByBookId = new Map<
            string,
            Array<{ id: string; name: string; isPersonal: boolean }>
          >();

          for (const row of collectionRows) {
            const list = collectionsByBookId.get(row.bookId) ?? [];
            list.push({
              id: row.id,
              name: row.name,
              isPersonal: Boolean(row.isPersonal),
            });
            collectionsByBookId.set(row.bookId, list);
          }

          for (const p of samplePairs) {
            const pair = p as {
              a?: { id?: string; owner?: unknown; collections?: unknown };
              b?: { id?: string; owner?: unknown; collections?: unknown };
            };
            const aId = pair.a?.id;
            const bId = pair.b?.id;

            if (pair.a && aId) {
              pair.a.owner = ownerByBookId.get(aId) ?? null;
              pair.a.collections = collectionsByBookId.get(aId) ?? [];
            }
            if (pair.b && bId) {
              pair.b.owner = ownerByBookId.get(bId) ?? null;
              pair.b.collections = collectionsByBookId.get(bId) ?? [];
            }
          }
        }
      } catch {
        // If enrichment fails, still return the core pair list.
      }

      results.push({
        id: 'duplicates.fuzzy-title-author',
        name: 'Possible duplicates (fuzzy title/author)',
        status: foundPairs > 0 ? 'warn' : 'ok',
        message:
          foundPairs > 0
            ? `${foundPairs} possible duplicate pair(s) found by fuzzy match`
            : 'No fuzzy title/author duplicates found',
        howToFix:
          foundPairs > 0
            ? 'Review each pair and decide whether to keep both or de-duplicate (merge tooling is planned).'
            : undefined,
        meta: {
          scannedBooks: bookRows.length,
          comparisons,
          threshold: FUZZY_DUPLICATE_THRESHOLD,
          maxBooksForFuzzy,
          maxFuzzyComparisons,
        },
        sample: samplePairs,
      });
    }

    // 5) Book file pointers exist on disk
    {
      const rows = await cloudDb
        .select({
          id: bookFiles.id,
          bookId: bookFiles.bookId,
          format: bookFiles.format,
          relativePath: bookFiles.relativePath,
        })
        .from(bookFiles)
        .limit(maxFilesToStat);

      let missing = 0;
      const sampleMissing: Array<Record<string, unknown>> = [];

      for (const r of rows) {
        const rel = (r.relativePath ?? '').toString().trim();
        if (!rel) continue;
        let abs: string;
        try {
          abs = resolveStoredPathUnderLibrary(rel).abs;
        } catch {
          missing++;
          if (sampleMissing.length < sampleLimit) {
            sampleMissing.push({
              id: r.id,
              bookId: r.bookId,
              relativePath: r.relativePath,
              reason: 'invalid-path',
            });
          }
          continue;
        }

        const ok = await existsFile(abs);
        if (!ok) {
          missing++;
          if (sampleMissing.length < sampleLimit) {
            sampleMissing.push({
              id: r.id,
              bookId: r.bookId,
              relativePath: r.relativePath,
            });
          }
        }
      }

      results.push({
        id: 'book-files.missing-on-disk',
        name: 'Book files missing on disk',
        status: missing > 0 ? 'error' : 'ok',
        message:
          missing > 0
            ? `${missing} book file pointer(s) do not exist on disk`
            : 'All checked book file pointers exist on disk',
        howToFix:
          missing > 0
            ? 'Restore missing files under library/, update the stored relative path, or remove the broken book_files row.'
            : undefined,
        meta: { checked: rows.length, missing, maxFilesToStat },
        sample: sampleMissing,
      });
    }

    // 6) cover_image_path exists on disk (when set)
    {
      const rows = await cloudDb
        .select({ id: books.id, coverImagePath: books.coverImagePath })
        .from(books)
        .where(sql`${books.coverImagePath} IS NOT NULL AND TRIM(${books.coverImagePath}) <> ''`)
        .limit(maxFilesToStat);

      let missing = 0;
      const sampleMissing: Array<Record<string, unknown>> = [];

      for (const r of rows) {
        const rel = (r.coverImagePath ?? '').toString().trim();
        if (!rel) continue;
        let abs: string;
        try {
          abs = resolveStoredPathUnderLibrary(rel).abs;
        } catch {
          missing++;
          if (sampleMissing.length < sampleLimit) {
            sampleMissing.push({
              bookId: r.id,
              coverImagePath: r.coverImagePath,
              reason: 'invalid-path',
            });
          }
          continue;
        }

        const ok = await existsFile(abs);
        if (!ok) {
          missing++;
          if (sampleMissing.length < sampleLimit) {
            sampleMissing.push({ bookId: r.id, coverImagePath: r.coverImagePath });
          }
        }
      }

      results.push({
        id: 'covers.cover-image-path-missing-on-disk',
        name: 'Cover image path missing on disk',
        status: missing > 0 ? 'warn' : 'ok',
        message:
          missing > 0
            ? `${missing} book(s) have cover_image_path set but the file is missing`
            : 'All checked cover_image_path files exist on disk',
        howToFix:
          missing > 0
            ? 'Regenerate the thumbnail/cover file for the book, or clear cover_image_path if no cover should be shown.'
            : undefined,
        meta: { checked: rows.length, missing, maxFilesToStat },
        sample: sampleMissing,
      });
    }

    // 7) If cover exists, thumb.webp should exist (directory scan limited to referenced dirs)
    {
      const fileRows = await cloudDb
        .select({ relativePath: bookFiles.relativePath })
        .from(bookFiles)
        .limit(maxDirsToStat);

      const coverRows = await cloudDb
        .select({ coverImagePath: books.coverImagePath })
        .from(books)
        .where(sql`${books.coverImagePath} IS NOT NULL AND TRIM(${books.coverImagePath}) <> ''`)
        .limit(maxDirsToStat);

      const dirs = new Set<string>();
      for (const r of fileRows) {
        const rel = (r.relativePath ?? '').toString().trim();
        if (!rel) continue;
        const dir = dirnamePosix(rel);
        if (dir) dirs.add(dir);
      }
      for (const r of coverRows) {
        const rel = (r.coverImagePath ?? '').toString().trim();
        if (!rel) continue;
        const dir = dirnamePosix(rel);
        if (dir) dirs.add(dir);
      }

      const dirList = Array.from(dirs).slice(0, maxDirsToStat);

      let coverDirs = 0;
      let missingThumb = 0;
      const sampleMissing: Array<Record<string, unknown>> = [];

      for (const dirRelPosix of dirList) {
        let dirAbs: string;
        try {
          dirAbs = resolveStoredPathUnderLibrary(`${dirRelPosix}/x`).abs;
          dirAbs = path.dirname(dirAbs);
        } catch {
          continue;
        }

        if (!(await existsDir(dirAbs))) continue;

        const thumbAbs = path.join(dirAbs, 'thumb.webp');
        const thumbOk = await existsFile(thumbAbs);
        if (thumbOk) continue;

        let foundCover = false;
        for (const name of COVER_CANDIDATES) {
          if (await existsFile(path.join(dirAbs, name))) {
            foundCover = true;
            break;
          }
        }

        if (!foundCover) continue;

        coverDirs++;
        missingThumb++;

        if (sampleMissing.length < sampleLimit) {
          sampleMissing.push({
            dir: `library/${dirRelPosix.replace(/^library[\\/]/, '')}`,
          });
        }
      }

      results.push({
        id: 'covers.missing-thumb-when-cover-exists',
        name: 'Missing thumb.webp when a cover exists',
        status: missingThumb > 0 ? 'warn' : 'ok',
        message:
          missingThumb > 0
            ? `${missingThumb} book folder(s) have a cover but no thumb.webp`
            : 'No missing thumbnails found in referenced book folders',
        howToFix:
          missingThumb > 0
            ? 'Regenerate the thumbnail (thumb.webp) for each affected folder.'
            : undefined,
        meta: { checkedDirs: dirList.length, coverDirs, missingThumb, maxDirsToStat },
        sample: sampleMissing,
      });
    }
  }

  const finishedAt = new Date().toISOString();

  const overall = results.reduce<HealthStatus>(
    (acc, r) => worstStatus(acc, r.status),
    'ok',
  );

  return {
    success: true,
    data: {
      mode,
      startedAt,
      finishedAt,
      overall,
      results,
    },
  };
});
