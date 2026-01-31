import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  books,
  bookIdentifiers,
  collectionBooks,
  collectionMembers,
  publishers,
  series,
  tags,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/search?q=...
 *
 * Unified global search endpoint:
 * - Searches across multiple entity types (books, authors, series, publishers, tags)
 * - Returns grouped buckets with a per-bucket limit.
 *
 * Notes:
 * - Uses pragmatic "fuzzy-ish" matching via SQLite LIKE:
 *   - prefix match
 *   - contains match
 * - Scores in-memory for stable ordering.
 * - Books are scoped to the caller's accessible collections (via collection membership).
 * - Non-book entities are currently global (not collection-scoped) to match existing endpoints.
 *
 * Query params:
 * - q: string (required)
 * - limit: number (optional) per-bucket limit; default from DEFAULT_PER_BUCKET_LIMIT; max 50
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/search');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const { q, limit } = getQuery(event) as { q?: string; limit?: string };

  const raw = (q ?? '').toString().trim();

  const DEFAULT_PER_BUCKET_LIMIT = 8; // future: wire to a user/global setting
  const requestedLimit = Number(limit ?? DEFAULT_PER_BUCKET_LIMIT);
  const perBucketLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(50, Math.floor(requestedLimit)))
    : DEFAULT_PER_BUCKET_LIMIT;

  if (!raw) {
    return {
      success: true,
      data: {
        q: raw,
        perBucketLimit,
        buckets: {
          books: [],
          authors: [],
          series: [],
          publishers: [],
          tags: [],
        },
      },
    };
  }

  // Defensive: escape LIKE wildcards. We intentionally do NOT treat user input as a pattern.
  const escapeLike = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

  const needle = escapeLike(raw);
  const prefix = `${needle}%`;
  const contains = `%${needle}%`;
  const lowerNeedle = raw.toLowerCase();

  function normalizeIdentifierCandidate(input: string): string {
    const stripped = input
      // common barcode/scanner formats
      .replace(/^\s*isbn(?:-?1[03])?\s*[:#]?\s*/i, '')
      .trim();

    // remove whitespace/hyphens/punctuation while keeping alphanumerics (ISBN10 may end with X)
    return stripped.replace(/[^0-9A-Za-z]+/g, '').toUpperCase();
  }

  const normalizedIdentNeedle = normalizeIdentifierCandidate(raw);
  const isProbablyIdentifierQuery =
    /^\s*isbn/i.test(raw) ||
    /^[0-9Xx-\s]{10,}$/.test(raw) ||
    /^[0-9]{13}$/.test(normalizedIdentNeedle) ||
    /^[0-9X]{10}$/.test(normalizedIdentNeedle);

  function scoreName(name: string) {
    const lower = (name ?? '').toLowerCase();
    const starts = lower.startsWith(lowerNeedle);
    const idx = lower.indexOf(lowerNeedle);

    // Smaller is better, tuned to keep prefix first but still stable.
    return (
      (starts ? 0 : 100) +
      (idx >= 0 ? idx : 10_000) +
      Math.min((name ?? '').length, 10_000) / 10_000
    );
  }

  function rankRows<T extends { id: string; name: string }>(
    rows: T[],
    take: number,
  ) {
    const seen = new Set<string>();
    const unique = rows.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    return unique
      .map((r) => ({ ...r, _score: scoreName(r.name) }))
      .sort((a, b) => {
        if (a._score !== b._score) return a._score - b._score;
        const aLen = a.name.length;
        const bLen = b.name.length;
        if (aLen !== bLen) return aLen - bLen;
        return a.name.localeCompare(b.name);
      })
      .slice(0, take)
      .map(({ id, name }) => ({ id, name }));
  }

  try {
    // ---- Collection scope for books (membership-based)
    const memberRows = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, session.user.id));

    const allowedCollectionIds = memberRows.map((r) => r.collectionId);

    // If the user has no collections, they can't see any books.
    const booksPromise = (async () => {
      if (allowedCollectionIds.length === 0) return [];

      type RawBookRow = {
        id: string;
        title: string | null;
        published: string | null;
        createdAt: unknown;
        coverImagePath: string | null;
      };

      type BookRowWithMatch = RawBookRow & {
        match: {
          kind: 'titlePrefix' | 'titleContains' | 'author' | 'identifier';
        };
        matchedIdentifierValue?: string | null;
      };

      // Books that match by title directly (scoped by membership)
      const titlePrefixRows: RawBookRow[] = await cloudDb
        .select({
          id: books.id,
          title: books.title,
          published: books.published,
          createdAt: books.createdAt,
          coverImagePath: books.coverImagePath,
        })
        .from(books)
        .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
        .where(
          and(
            inArray(collectionBooks.collectionId, allowedCollectionIds),
            like(books.title, prefix),
          ),
        )
        // Intentionally pull more for ranking/de-duping (books can appear in many collections)
        .limit(Math.max(perBucketLimit * 8, 80));

      const titleContainsRows: RawBookRow[] = await cloudDb
        .select({
          id: books.id,
          title: books.title,
          published: books.published,
          createdAt: books.createdAt,
          coverImagePath: books.coverImagePath,
        })
        .from(books)
        .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
        .where(
          and(
            inArray(collectionBooks.collectionId, allowedCollectionIds),
            like(books.title, contains),
          ),
        )
        .limit(Math.max(perBucketLimit * 12, 120));

      // Books that match by author name (scoped by membership)
      const authorMatchRows: RawBookRow[] = await cloudDb
        .select({
          id: books.id,
          title: books.title,
          published: books.published,
          createdAt: books.createdAt,
          coverImagePath: books.coverImagePath,
        })
        .from(books)
        .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
        .innerJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
        .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
        .where(
          and(
            inArray(collectionBooks.collectionId, allowedCollectionIds),
            like(authors.name, contains),
          ),
        )
        .limit(Math.max(perBucketLimit * 12, 120));

      // Books that match by identifier value (e.g. ISBN) (scoped by membership)
      const identifierMatchRows: Array<
        RawBookRow & { matchedIdentifierValue: string | null }
      > =
        isProbablyIdentifierQuery && normalizedIdentNeedle.length >= 4
          ? await cloudDb
              .select({
                id: books.id,
                title: books.title,
                published: books.published,
                createdAt: books.createdAt,
                coverImagePath: books.coverImagePath,
                matchedIdentifierValue: bookIdentifiers.value,
              })
              .from(books)
              .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
              .innerJoin(bookIdentifiers, eq(bookIdentifiers.bookId, books.id))
              .where(
                and(
                  inArray(collectionBooks.collectionId, allowedCollectionIds),
                  like(
                    sql`UPPER(${bookIdentifiers.value})`,
                    `%${escapeLike(normalizedIdentNeedle)}%`,
                  ),
                ),
              )
              // Pull more: multiple identifiers per book can yield duplicates
              .limit(Math.max(perBucketLimit * 20, 200))
          : [];

      function matchPriority(row: BookRowWithMatch): number {
        if (row.match.kind === 'identifier') {
          const ident = normalizeIdentifierCandidate(
            String(row.matchedIdentifierValue ?? ''),
          );
          if (ident && ident === normalizedIdentNeedle) return 0; // exact
          if (
            ident &&
            normalizedIdentNeedle &&
            ident.startsWith(normalizedIdentNeedle)
          )
            return 1; // prefix
          return 2; // contains / other
        }

        if (row.match.kind === 'titlePrefix') return 10;
        if (row.match.kind === 'titleContains') return 20;
        if (row.match.kind === 'author') return 30;
        return 50;
      }

      // Merge + de-dup by book.id, keeping the best (lowest) matchPriority per book
      const merged: BookRowWithMatch[] = [
        ...titlePrefixRows.map((r) => ({
          ...r,
          match: { kind: 'titlePrefix' as const },
        })),
        ...titleContainsRows.map((r) => ({
          ...r,
          match: { kind: 'titleContains' as const },
        })),
        ...authorMatchRows.map((r) => ({
          ...r,
          match: { kind: 'author' as const },
        })),
        ...identifierMatchRows.map((r) => ({
          ...r,
          match: { kind: 'identifier' as const },
        })),
      ];

      const bestById = new Map<string, BookRowWithMatch>();
      for (const row of merged) {
        const existing = bestById.get(row.id);
        if (!existing) {
          bestById.set(row.id, row);
          continue;
        }

        const currPri = matchPriority(row);
        const prevPri = matchPriority(existing);
        if (currPri < prevPri) bestById.set(row.id, row);
      }

      const unique = Array.from(bestById.values());

      // Rank by title match first, then recency as a tie-breaker.
      const scored = unique
        .map((r) => {
          const title = r.title ?? '';
          const titleScore = scoreName(title);
          const pri = matchPriority(r);
          // Newer first as a mild tie-breaker
          const recency =
            r.createdAt instanceof Date
              ? r.createdAt.getTime()
              : Number(r.createdAt ?? 0);
          return { ...r, _score: pri * 1000 + titleScore, _recency: recency };
        })
        .sort((a, b) => {
          if (a._score !== b._score) return a._score - b._score;
          if (a._recency !== b._recency) return b._recency - a._recency;
          return (a.title ?? '').localeCompare(b.title ?? '');
        })
        .slice(0, perBucketLimit);

      // Attach a compact author string
      const bookIds = scored.map((b) => b.id);
      if (bookIds.length === 0) return [];

      const authorLinks = await cloudDb
        .select({
          bookId: bookAuthors.bookId,
          authorName: authors.name,
          position: bookAuthors.position,
        })
        .from(bookAuthors)
        .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
        .where(inArray(bookAuthors.bookId, bookIds));

      const byBook = new Map<
        string,
        Array<{ name: string; position: number | null }>
      >();
      for (const row of authorLinks) {
        const list = byBook.get(row.bookId) ?? [];
        list.push({ name: row.authorName, position: row.position ?? null });
        byBook.set(row.bookId, list);
      }

      const identifierLinks = await cloudDb
        .select({
          bookId: bookIdentifiers.bookId,
          type: bookIdentifiers.type,
          value: bookIdentifiers.value,
        })
        .from(bookIdentifiers)
        .where(inArray(bookIdentifiers.bookId, bookIds));

      const identifiersByBook = new Map<
        string,
        Array<{ type: string; value: string }>
      >();

      for (const row of identifierLinks) {
        const list = identifiersByBook.get(row.bookId) ?? [];
        list.push({ type: row.type, value: row.value });
        identifiersByBook.set(row.bookId, list);
      }

      return scored.map((b) => {
        const list = (byBook.get(b.id) ?? []).slice().sort((a, bb) => {
          // position can be null; keep nulls last, alphabetical within same pos
          const ap = a.position ?? 9999;
          const bp = bb.position ?? 9999;
          if (ap !== bp) return ap - bp;
          return a.name.localeCompare(bb.name);
        });

        const authorNames = list.map((x) => x.name).filter(Boolean);
        const identifiers = (identifiersByBook.get(b.id) ?? [])
          .filter((x) => (x.type ?? '').toLowerCase().includes('isbn'))
          .slice()
          .sort((a, bb) => {
            const at = a.type.toLowerCase();
            const bt = bb.type.toLowerCase();
            if (at !== bt) return at.localeCompare(bt);
            return a.value.localeCompare(bb.value);
          })
          .slice(0, 4);

        return {
          id: b.id,
          title: b.title,
          subtitle: authorNames.length ? authorNames.join(', ') : null,
          identifiers,
          published: b.published ?? null,
          coverImagePath: b.coverImagePath ?? null,
        };
      });
    })();

    // ---- Simple buckets (global, not collection-scoped)
    const authorsPromise = (async () => {
      const prefixRows = await cloudDb
        .select({ id: authors.id, name: authors.name })
        .from(authors)
        .where(like(authors.name, prefix))
        .limit(perBucketLimit);

      const containsRows = await cloudDb
        .select({ id: authors.id, name: authors.name })
        .from(authors)
        .where(like(authors.name, contains))
        .limit(Math.max(perBucketLimit * 5, 25));

      return rankRows([...prefixRows, ...containsRows], perBucketLimit);
    })();

    const seriesPromise = (async () => {
      const prefixRows = await cloudDb
        .select({ id: series.id, name: series.name })
        .from(series)
        .where(like(series.name, prefix))
        .limit(perBucketLimit);

      const containsRows = await cloudDb
        .select({ id: series.id, name: series.name })
        .from(series)
        .where(like(series.name, contains))
        .limit(Math.max(perBucketLimit * 5, 25));

      return rankRows([...prefixRows, ...containsRows], perBucketLimit);
    })();

    const publishersPromise = (async () => {
      const prefixRows = await cloudDb
        .select({ id: publishers.id, name: publishers.name })
        .from(publishers)
        .where(like(publishers.name, prefix))
        .limit(perBucketLimit);

      const containsRows = await cloudDb
        .select({ id: publishers.id, name: publishers.name })
        .from(publishers)
        .where(like(publishers.name, contains))
        .limit(Math.max(perBucketLimit * 5, 25));

      return rankRows([...prefixRows, ...containsRows], perBucketLimit);
    })();

    const tagsPromise = (async () => {
      const prefixRows = await cloudDb
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(like(tags.name, prefix))
        .limit(perBucketLimit);

      const containsRows = await cloudDb
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(like(tags.name, contains))
        .limit(Math.max(perBucketLimit * 5, 25));

      return rankRows([...prefixRows, ...containsRows], perBucketLimit);
    })();

    const [
      booksBucket,
      authorsBucket,
      seriesBucket,
      publishersBucket,
      tagsBucket,
    ] = await Promise.all([
      booksPromise,
      authorsPromise,
      seriesPromise,
      publishersPromise,
      tagsPromise,
    ]);

    return {
      success: true,
      data: {
        q: raw,
        perBucketLimit,
        buckets: {
          books: booksBucket,
          authors: authorsBucket,
          series: seriesBucket,
          publishers: publishersBucket,
          tags: tagsBucket,
        },
      },
    };
  } catch (error: unknown) {
    logger.error(error, 'GET /api/search: failed');
    throw createError({ statusCode: 500, statusMessage: 'Failed to search' });
  }
});
