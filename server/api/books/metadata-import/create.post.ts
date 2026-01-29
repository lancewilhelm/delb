import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { and, eq, inArray } from 'drizzle-orm';

import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  bookIdentifiers,
  bookTags,
  books,
  collectionBooks,
  collectionMembers,
  collections,
  publishers,
  series,
  tags,
} from '~/utils/db/schema';

import { resolveDataPath } from '~~/server/utils/books/fs';
import { buildBookStorageRelativePath } from '~~/server/utils/books/storage/paths';
import { moveBookStorageToCanonical } from '~~/server/utils/books/storage/move/move-book-storage';
import { ensureCoverOutputsFromBytes } from '~~/server/utils/books/covers';
import { makeAuthorSortKey, makeTitleSortKey } from '~~/server/utils/sort/keys';
import { normalizePublishedAt } from '~~/server/utils/books/published';
import {
  fetchTopMetadataItemByDefaultProvider,
  type GoogleBookItem,
} from '~~/server/utils/books/metadata/top-result';
import { findPossibleDuplicates } from '~~/server/utils/books/duplicates';

type MetadataProviderKey = 'googleBooks' | 'hardcover';

type DuplicateAction = 'add_new' | 'use_existing' | 'replace_existing';

type Body = {
  /**
   * Search query string. Generally a title, but can be anything supported by the provider.
   */
  query?: string;

  /**
   * Optional provider key when providing a concrete metadata item.
   * When omitted and `query` is used, the server uses the configured default provider.
   */
  provider?: MetadataProviderKey;

  /**
   * Optional concrete metadata item (Google-like shape). When present, the server will
   * import this item directly instead of fetching the top result for `query`.
   */
  item?: GoogleBookItem;

  /**
   * One or more target collection IDs. If empty/missing, defaults to the user's Personal collection.
   */
  collectionIds?: string[];

  /**
   * Duplicate-resolution behavior:
   * - When omitted, the server will block on possible duplicates (409) and return candidates.
   * - `use_existing`: add the selected existing book to missing collections (no new book created).
   * - `replace_existing`: replace the selected existing book's metadata with the incoming metadata,
   *   and add it to missing collections.
   * - `add_new`: create a new book even if a possible duplicate exists.
   */
  duplicateAction?: DuplicateAction;

  /**
   * Selected existing book id to use/replace when resolving duplicates.
   * Must be one of the returned duplicate candidates.
   */
  existingBookId?: string;

  /**
   * Back-compat: if true, skip "possible duplicate" blocking and proceed with creation.
   * Equivalent to `duplicateAction: 'add_new'`.
   */
  allowDuplicate?: boolean;
};

function makeAbsoluteUrl(
  event: {
    node: {
      req: {
        headers: Record<string, string | string[] | undefined>;
      };
    };
  },
  relativeOrAbsolute: string,
): string {
  const raw = (relativeOrAbsolute ?? '').toString().trim();
  if (!raw) return raw;

  // Already absolute
  if (/^https?:\/\//i.test(raw)) return raw;

  // Build base from incoming request headers (works behind reverse proxies if they forward proto/host)
  const proto =
    (event.node.req.headers['x-forwarded-proto'] as string | undefined)
      ?.split(',')[0]
      ?.trim() ||
    (event.node.req.headers['x-forwarded-protocol'] as string | undefined)
      ?.split(',')[0]
      ?.trim() ||
    'http';
  const host =
    (event.node.req.headers['x-forwarded-host'] as string | undefined)
      ?.split(',')[0]
      ?.trim() ||
    (event.node.req.headers['host'] as string | undefined)?.trim() ||
    'localhost';

  const base = `${proto}://${host}`;

  if (raw.startsWith('/')) return `${base}${raw}`;
  return `${base}/${raw}`;
}

function uniqByLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const cleaned = v.trim();
    if (!cleaned) continue;
    const k = cleaned.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(cleaned);
  }
  return out;
}

function normalizeIdentifierType(input: unknown): string {
  return (input ?? '').toString().trim().toLowerCase();
}

function normalizeIdentifierTypeFromProvider(input: unknown): string {
  const t = normalizeIdentifierType(input);
  // Google Books types
  if (t === 'isbn_13' || t === 'isbn13' || t === 'isbn-13') return 'isbn13';
  if (t === 'isbn_10' || t === 'isbn10' || t === 'isbn-10') return 'isbn10';
  if (t === 'isbn') return 'isbn';
  return t;
}

function normalizeIdentifierValue(input: unknown): string {
  const v = (input ?? '').toString().trim();
  return v.replace(/[\s-]+/g, '');
}

function getGoogleCoverUrlFromVolumeInfo(vi: {
  imageLinks?: { thumbnail?: string; smallThumbnail?: string };
}): string | null {
  const raw = vi.imageLinks?.thumbnail || vi.imageLinks?.smallThumbnail || null;

  if (!raw) return null;

  return raw.replace('&edge=curl', '');
}

async function findOrCreateTagByName(name: string) {
  const existing = await cloudDb
    .select()
    .from(tags)
    .where(eq(tags.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(tags).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

function toNonEmptyStringOrNull(input: unknown): string | null {
  const v = typeof input === 'string' ? input.trim() : '';
  return v ? v : null;
}

function isAdminRole(role: unknown): boolean {
  return role === 'admin' || role === 'owner';
}

function normalizeDuplicateAction(
  input: unknown,
  allowDuplicate: unknown,
): DuplicateAction | null {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === 'add_new' || raw === 'use_existing' || raw === 'replace_existing')
    return raw;
  return allowDuplicate ? 'add_new' : null;
}

function isGoogleBookItem(input: unknown): input is GoogleBookItem {
  if (!input || typeof input !== 'object') return false;
  if (!('id' in input)) return false;
  if (!('volumeInfo' in input)) return false;
  const id = (input as { id?: unknown }).id;
  const volumeInfo = (input as { volumeInfo?: unknown }).volumeInfo;
  return typeof id === 'string' && !!id.trim() && !!volumeInfo && typeof volumeInfo === 'object';
}

/**
 * Ensure the user can add books to every target collection.
 * Mirrors the permission behavior used by upload.
 */
async function assertCanAddToCollections(opts: {
  userId: string;
  collectionIds: string[];
}) {
  const uniqueIds = Array.from(new Set(opts.collectionIds)).filter(Boolean);
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
        'You do not have permission to add to one or more selected collections',
    });
  }
}

/**
 * Defaults to the user's Personal collection when no collectionIds are provided.
 * Mirrors upload behavior.
 */
async function resolveCollectionIdsOrPersonal(opts: {
  userId: string;
  collectionIds?: string[];
}): Promise<string[]> {
  const incoming = Array.isArray(opts.collectionIds)
    ? opts.collectionIds.filter((x) => typeof x === 'string' && x.trim())
    : [];

  if (incoming.length) return Array.from(new Set(incoming));

  const personal = await cloudDb
    .select({ id: collections.id })
    .from(collectionMembers)
    .innerJoin(collections, eq(collectionMembers.collectionId, collections.id))
    .where(
      and(
        eq(collectionMembers.userId, opts.userId),
        eq(collections.isPersonal, true),
      ),
    )
    .limit(1);

  const personalCollectionId = personal[0]?.id;

  if (!personalCollectionId) {
    throw createError({
      statusCode: 400,
      statusMessage:
        'Personal collection not found. Please try again after your Personal collection is created.',
    });
  }

  return [personalCollectionId];
}

/**
 * Find or create an author by name (lean v1: unique by exact name).
 * Matches upload approach.
 */
async function findOrCreateAuthorByName(name: string) {
  const existing = await cloudDb
    .select()
    .from(authors)
    .where(eq(authors.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(authors).values({
    id,
    name,
    sortName: makeAuthorSortKey(name),
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

/**
 * Find-or-create publisher/series by name if schema supports it.
 * These are best-effort and will be skipped if insert fails due to constraints.
 */
async function findOrCreatePublisherByName(name: string) {
  const existing = await cloudDb
    .select()
    .from(publishers)
    .where(eq(publishers.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(publishers).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

async function findOrCreateSeriesByName(name: string) {
  const existing = await cloudDb
    .select()
    .from(series)
    .where(eq(series.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(series).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

async function addBookToCollectionsMissing(opts: {
  userId: string;
  bookId: string;
  collectionIds: string[];
}) {
  const uniqueCollectionIds = Array.from(new Set(opts.collectionIds)).filter(
    Boolean,
  );
  if (!uniqueCollectionIds.length) return { addedCollectionIds: [] as string[] };

  const existing = await cloudDb
    .select({ collectionId: collectionBooks.collectionId })
    .from(collectionBooks)
    .where(
      and(
        eq(collectionBooks.bookId, opts.bookId),
        inArray(collectionBooks.collectionId, uniqueCollectionIds),
      ),
    );

  const already = new Set(existing.map((r) => r.collectionId));
  const missing = uniqueCollectionIds.filter((id) => !already.has(id));
  if (!missing.length) return { addedCollectionIds: [] as string[] };

  const now = new Date();
  for (const collectionId of missing) {
    await cloudDb.insert(collectionBooks).values({
      collectionId,
      bookId: opts.bookId,
      addedByUserId: opts.userId,
      addedAt: now,
    });
  }

  return { addedCollectionIds: missing };
}

export default defineEventHandler(async (event) => {
  logger.debug('POST /api/books/metadata-import/create');

  // Require auth
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;

  const body = (await readBody(event)) as Partial<Body>;
  const query = (body.query ?? '').toString().trim();

  // Resolve collections + permissions
  const collectionIds = await resolveCollectionIdsOrPersonal({
    userId,
    collectionIds: body.collectionIds,
  });
  await assertCanAddToCollections({ userId, collectionIds });

  const duplicateAction = normalizeDuplicateAction(
    body.duplicateAction,
    body.allowDuplicate,
  );

  const incomingProvider: MetadataProviderKey | null =
    body.provider === 'googleBooks' || body.provider === 'hardcover'
      ? body.provider
      : null;

  let metadataItem: GoogleBookItem | null = null;
  if (body.item !== undefined) {
    if (!isGoogleBookItem(body.item)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid "item" in request body',
      });
    }
    metadataItem = body.item;
  }
  let provider: MetadataProviderKey | null = incomingProvider;

  // Fetch top metadata item using the default provider when a concrete `item` isn't provided.
  if (!metadataItem) {
    if (!query) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Missing "query" in request body',
      });
    }

    const top = await fetchTopMetadataItemByDefaultProvider({ query });
    if (!top.ok) {
      throw createError({
        statusCode: top.statusCode,
        statusMessage: top.message,
      });
    }

    metadataItem = top.item;
    provider = top.provider;
  }

  if (!provider) {
    // If the client provided an item without a provider, default to googleBooks for now.
    provider = 'googleBooks';
  }

  const vi = metadataItem.volumeInfo ?? {};
  const title = (vi.title ?? '').toString().trim() || 'Untitled';

  // Authors: we attach authors using the same linking table as upload.
  // If metadata has none, fall back to Unknown Author (consistent UX).
  const authorNames = uniqByLower(Array.isArray(vi.authors) ? vi.authors : []);
  const authorsToAttach = authorNames.length ? authorNames : ['Unknown Author'];

  const description = toNonEmptyStringOrNull(vi.description);
  const language = toNonEmptyStringOrNull(vi.language);

  const published = toNonEmptyStringOrNull(vi.publishedDate);
  const publishedAt = published ? normalizePublishedAt(published) : null;

  const publisherName = toNonEmptyStringOrNull(vi.publisher);

  const seriesName = toNonEmptyStringOrNull(
    (vi as { series?: unknown }).series,
  );
  const seriesIndexRaw = (vi as { seriesIndex?: unknown }).seriesIndex;
  const seriesIndex =
    typeof seriesIndexRaw === 'number' && !Number.isNaN(seriesIndexRaw)
      ? seriesIndexRaw
      : null;

  const pagesRaw = (vi as { pageCount?: unknown }).pageCount;
  const pages =
    typeof pagesRaw === 'number' && !Number.isNaN(pagesRaw) ? pagesRaw : null;

  const categories = Array.isArray(vi.categories)
    ? uniqByLower(vi.categories)
    : [];
  const industryIdentifiers = Array.isArray(vi.industryIdentifiers)
    ? vi.industryIdentifiers
        .map((x) => ({
          type: normalizeIdentifierTypeFromProvider((x as { type?: unknown })?.type),
          value: normalizeIdentifierValue(
            (x as { identifier?: unknown })?.identifier,
          ),
        }))
        .filter((x) => x.type && x.value)
    : [];

  const coverUrl = getGoogleCoverUrlFromVolumeInfo(vi);

  const now = new Date();
  const candidates = await findPossibleDuplicates({
    title,
    author: authorsToAttach.join(', '),
    identifiers: industryIdentifiers,
    maxCandidates: 8,
  });

  const hasCandidates = candidates.length > 0;
  const selectedExistingBookId = (body.existingBookId ?? '').toString().trim();

  if (hasCandidates && !duplicateAction) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Possible duplicate',
      data: {
        code: 'possible_duplicate',
        incoming: {
          title,
          author: authorsToAttach.join(', '),
          identifiers: industryIdentifiers,
          query,
          provider,
        },
        metadata: {
          provider,
          item: metadataItem,
        },
        candidates,
      },
    });
  }

  // Duplicate resolution: "use existing"
  if (hasCandidates && duplicateAction === 'use_existing') {
    const allowedIds = new Set(candidates.map((c) => c.book.id));
    const useBookId = selectedExistingBookId || candidates[0]!.book.id;
    if (!allowedIds.has(useBookId)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid existingBookId for duplicate resolution',
      });
    }

    const { addedCollectionIds } = await addBookToCollectionsMissing({
      userId,
      bookId: useBookId,
      collectionIds,
    });

    const row = await cloudDb
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(eq(books.id, useBookId))
      .limit(1);

    return {
      success: true,
      data: {
        book: {
          id: row[0]?.id ?? useBookId,
          title: row[0]?.title ?? '',
        },
        duplicateResolution: 'use_existing' as const,
        addedCollectionIds,
        provider,
        query,
        collectionIds,
      },
    };
  }

  // Duplicate resolution: "replace existing"
  if (hasCandidates && duplicateAction === 'replace_existing') {
    if (!isAdminRole((session.user as { role?: unknown }).role)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Only admins can replace an existing book entry',
      });
    }

    const allowedIds = new Set(candidates.map((c) => c.book.id));
    const replaceBookId = selectedExistingBookId || candidates[0]!.book.id;
    if (!allowedIds.has(replaceBookId)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid existingBookId for duplicate resolution',
      });
    }

    // Replace: clear and rebuild author/tag/identifier links, then overwrite canonical fields.
    const update: Partial<typeof books.$inferInsert> = {
      title,
      sortTitle: makeTitleSortKey(title),
      description,
      published,
      publishedAt,
      language,
      pages,
      updatedAt: new Date(),
    };

    // Optional relationships
    if (publisherName) {
      try {
        const pub = await findOrCreatePublisherByName(publisherName);
        update.publisherId = pub.id;
      } catch {
        // ignore
      }
    } else {
      update.publisherId = null;
    }

    if (seriesName) {
      try {
        const s = await findOrCreateSeriesByName(seriesName);
        update.seriesId = s.id;
        update.seriesIndex = seriesIndex;
      } catch {
        // ignore
      }
    } else {
      update.seriesId = null;
      update.seriesIndex = null;
    }

    await cloudDb.update(books).set(update as never).where(eq(books.id, replaceBookId));

    await cloudDb.delete(bookAuthors).where(eq(bookAuthors.bookId, replaceBookId));
    for (let i = 0; i < authorsToAttach.length; i++) {
      const name = authorsToAttach[i]!;
      const author = await findOrCreateAuthorByName(name);
      await cloudDb.insert(bookAuthors).values({
        bookId: replaceBookId,
        authorId: author.id,
        position: i + 1,
      });
    }

    await cloudDb.delete(bookTags).where(eq(bookTags.bookId, replaceBookId));
    if (categories.length) {
      for (const name of categories) {
        const t = await findOrCreateTagByName(name);
        await cloudDb.insert(bookTags).values({ bookId: replaceBookId, tagId: t.id });
      }
    }

    await cloudDb
      .delete(bookIdentifiers)
      .where(eq(bookIdentifiers.bookId, replaceBookId));
    if (industryIdentifiers.length) {
      for (const ident of industryIdentifiers) {
        await cloudDb.insert(bookIdentifiers).values({
          bookId: replaceBookId,
          type: ident.type,
          value: ident.value,
        });
      }
    }

    // Cover (best-effort): same logic as create, but targets the existing book id.
    if (coverUrl) {
      try {
        logger.debug(
          { bookId: replaceBookId, provider, coverUrl },
          'metadata-import: cover (replace): starting',
        );

        const dirMarkerRel = buildBookStorageRelativePath({
          authorNames: authorsToAttach,
          title,
          bookId: replaceBookId,
          filename: 'cover.thumb.webp',
          baseDir: 'library',
        });

        const outputDirRelPosix = path.posix.dirname(dirMarkerRel);
        const outputDirAbs = resolveDataPath(outputDirRelPosix);
        await mkdir(outputDirAbs, { recursive: true });

        const proxiedRelative = `/api/books/metadata/cover?url=${encodeURIComponent(coverUrl)}`;
        const proxiedAbs = makeAbsoluteUrl(event, proxiedRelative);

        const ab = await $fetch<ArrayBuffer>(proxiedAbs, {
          method: 'GET',
          headers: { 'x-delb-internal': '1' },
          responseType: 'arrayBuffer',
        });
        const bytes = Buffer.from(ab);

        const ensured = await ensureCoverOutputsFromBytes({
          sourceBytes: bytes,
          sourceMimeTypeHint: null,
          sourceExtensionHint: null,
          processing: {
            outputDirAbs,
            outputDirRelPosix,
            doNotOverwrite: false,
            sourceFormat: 'original',
            sourceBaseName: 'cover.source',
            thumbFileName: 'thumb.webp',
            thumbMaxWidth: 320,
            thumbWebpQuality: 80,
          },
        });

        await cloudDb
          .update(books)
          .set({
            coverImagePath: ensured.covers.thumb.relativePath,
            updatedAt: new Date(),
          } as never)
          .where(eq(books.id, replaceBookId));
      } catch (e) {
        logger.warn(
          { bookId: replaceBookId, err: e instanceof Error ? e.message : String(e) },
          'metadata-import: cover (replace): failed (continuing without cover)',
        );
      }
    }

    // Add to collections (only missing)
    const { addedCollectionIds } = await addBookToCollectionsMissing({
      userId,
      bookId: replaceBookId,
      collectionIds,
    });

    // Best-effort: keep storage canonical if title/authors changed.
    try {
      await moveBookStorageToCanonical({ bookId: replaceBookId });
    } catch (e) {
      logger.warn(
        { bookId: replaceBookId, err: e instanceof Error ? e.message : String(e) },
        'metadata-import: replace: move-to-canonical failed',
      );
    }

    return {
      success: true,
      data: {
        book: { id: replaceBookId, title },
        duplicateResolution: 'replace_existing' as const,
        addedCollectionIds,
        provider,
        query,
        collectionIds,
      },
    };
  }

  const bookId = crypto.randomUUID();

  // Create book
  // NOTE: This assumes your `books` table has optional columns:
  // - publisherId? seriesId? seriesIndex? pages?
  // If your schema differs, remove/adjust these fields.
  const bookInsert: Record<string, unknown> = {
    id: bookId,
    title,
    sortTitle: makeTitleSortKey(title),
    description,
    published,
    publishedAt,
    language,
    pages,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
  };

  // Optional relationships (best-effort)
  try {
    if (publisherName) {
      const pub = await findOrCreatePublisherByName(publisherName);
      bookInsert.publisherId = pub.id;
    }
  } catch {
    // ignore
  }

  try {
    if (seriesName) {
      const s = await findOrCreateSeriesByName(seriesName);
      bookInsert.seriesId = s.id;
      bookInsert.seriesIndex = seriesIndex;
    }
  } catch {
    // ignore
  }

  await cloudDb.insert(books).values(bookInsert as never);

  // Best-effort relations + metadata tables

  // Attach authors (positions are 1-based)
  for (let i = 0; i < authorsToAttach.length; i++) {
    const name = authorsToAttach[i]!;
    const author = await findOrCreateAuthorByName(name);

    await cloudDb.insert(bookAuthors).values({
      bookId,
      authorId: author.id,
      position: i + 1,
    });
  }

  // Tags (from categories)
  if (categories.length) {
    for (const name of categories) {
      const t = await findOrCreateTagByName(name);
      await cloudDb.insert(bookTags).values({
        bookId,
        tagId: t.id,
      });
    }
  }

  // Identifiers
  if (industryIdentifiers.length) {
    for (const ident of industryIdentifiers) {
      await cloudDb.insert(bookIdentifiers).values({
        bookId,
        type: ident.type,
        value: ident.value,
      });
    }
  }

  // Cover: download the cover image via the existing metadata cover proxy,
  // then generate/store:
  // - source cover bytes (full-res)
  // - thumb webp (320px wide)
  // and persist `books.coverImagePath` to the thumb path.
  if (coverUrl) {
    try {
      logger.debug(
        { bookId, provider, coverUrl },
        'metadata-import: cover: starting',
      );

      // Determine canonical book directory: `library/<authors>/<title (id8)>/`
      // We use storage path helper to ensure author/title/id are incorporated consistently.
      const dirMarkerRel = buildBookStorageRelativePath({
        authorNames: authorsToAttach,
        title,
        bookId,
        filename: 'cover.thumb.webp',
        baseDir: 'library',
      });

      const outputDirRelPosix = path.posix.dirname(dirMarkerRel);
      const outputDirAbs = resolveDataPath(outputDirRelPosix);

      // Ensure directory exists up-front (covers util also ensures, but this keeps intent explicit)
      await mkdir(outputDirAbs, { recursive: true });

      // Fetch bytes through our server proxy (avoids CORS + follows redirects)
      // IMPORTANT: server-side $fetch with a relative URL can be treated as an upstream fetch.
      // Use an absolute URL based on the current request host/proto.
      const proxiedRelative = `/api/books/metadata/cover?url=${encodeURIComponent(coverUrl)}`;
      const proxiedAbs = makeAbsoluteUrl(event, proxiedRelative);

      logger.debug(
        { bookId, proxiedAbs, outputDirRelPosix },
        'metadata-import: cover: fetching bytes',
      );

      // Fetch as *binary*, not Blob. Some $fetch implementations will return a Blob if
      // you don't force the response type.
      const ab = await $fetch<ArrayBuffer>(proxiedAbs, {
        method: 'GET',
        headers: {
          // Marks this request as originating from the server so the cover proxy
          // can bypass session auth (it will still enforce URL protocol + image type).
          'x-delb-internal': '1',
        },
        responseType: 'arrayBuffer',
      });

      const bytes = Buffer.from(ab);

      logger.debug(
        { bookId, byteLength: bytes.length },
        'metadata-import: cover: fetched bytes',
      );

      const ensured = await ensureCoverOutputsFromBytes({
        sourceBytes: bytes,
        sourceMimeTypeHint: null,
        sourceExtensionHint: null,
        processing: {
          outputDirAbs,
          outputDirRelPosix,
          // Always overwrite on metadata import so repeated adds are deterministic.
          doNotOverwrite: false,
          // Keep original if possible; trust upstream bytes.
          sourceFormat: 'original',
          sourceBaseName: 'cover.source',
          thumbFileName: 'thumb.webp',
          thumbMaxWidth: 320,
          thumbWebpQuality: 80,
        },
      });

      logger.debug(
        {
          bookId,
          coverThumbRel: ensured.covers.thumb.relativePath,
          coverSourceRel: ensured.covers.source.relativePath,
          changed: ensured.changed,
        },
        'metadata-import: cover: processed outputs',
      );

      await cloudDb
        .update(books)
        .set({
          coverImagePath: ensured.covers.thumb.relativePath,
          updatedAt: new Date(),
        } as never)
        .where(eq(books.id, bookId));

      logger.debug(
        { bookId, coverImagePath: ensured.covers.thumb.relativePath },
        'metadata-import: cover: saved coverImagePath',
      );
    } catch (e) {
      logger.warn(
        { bookId, err: e instanceof Error ? e.message : String(e) },
        'metadata-import: cover: failed (continuing without cover)',
      );
      // ignore cover failures
    }
  }

  // Add to collections
  for (const collectionId of collectionIds) {
    await cloudDb.insert(collectionBooks).values({
      collectionId,
      bookId,
      addedByUserId: userId,
      addedAt: now,
    });
  }

  return {
    success: true,
    data: {
      book: {
        id: bookId,
        title,
      },
      provider,
      query,
      collectionIds,
    },
  };
});
