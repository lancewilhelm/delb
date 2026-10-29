import { visibleEntity } from '~~/server/utils/books/visibility';
import { and, eq, inArray } from 'drizzle-orm';
import {
  bookSort,
  decodeCursor,
  nextBookCursor,
  normalizeSortDir,
  normalizeSortKey,
} from '~~/server/utils/books/book-sort';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  books,
  collectionBooks,
  collectionMembers,
  publishers,
  series,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/authors/:id/books?collectionId=<optional>&limit=<n>&cursor=<opaque>
 *
 * Returns books associated with a given author that the current user can access.
 *
 * Access control:
 * - Requires an authenticated user
 * - Only returns books that exist in collections the user is a member of
 * - Optional `collectionId` further scopes results to that one collection (if user is a member)
 *
 * Pagination:
 * - Returns `nextCursor` when more results exist
 *
 * Response shape mirrors GET /api/books (list) enough for reuse in the UI:
 * - includes `authors` ({id,name}[]) + `authorNames` + legacy `author`
 * - includes `publisher` ({id,name}|null) and `series` ({id,name}|null)
 */
function clampInt(
  input: unknown,
  opts: { min: number; max: number; fallback: number },
): number {
  const n = Number.parseInt((input ?? '').toString(), 10);
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, n));
}

export default defineEventHandler(async (event) => {
  logger.debug('GET /api/authors/:id/books');

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const userId = session.user.id;

  const authorId = getRouterParam(event, 'id');
  if (!authorId) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Missing author id' };
  }

  const q = getQuery(event) as {
    collectionId?: string;
    limit?: string;
    cursor?: string;
    sort?: string;
    sortDir?: string;
  };

  const collectionId = q.collectionId;
  const limit = clampInt(q.limit, { min: 1, max: 200, fallback: 48 });
  const sort = normalizeSortKey(q.sort);
  const sortDir = normalizeSortDir(q.sortDir, sort);
  const ordering = bookSort(sort, sortDir, decodeCursor(q.cursor));

  try {
    // Fetch author metadata (nice UX; still no access leak beyond existence of author row)
    const authorRow = await cloudDb
      .select({ id: authors.id, name: authors.name })
      .from(authors)
      .where(and(eq(authors.id, authorId), visibleEntity('author', userId)))
      .limit(1);

    const author = authorRow[0] ?? null;

    if (!author) {
      // Match the "don't leak much" style used elsewhere: 404
      throw createError({ statusCode: 404, statusMessage: 'Author not found' });
    }

    // 1) Determine which collections the user can see
    const memberships = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, userId));

    const memberCollectionIds = Array.from(
      new Set(memberships.map((m) => m.collectionId)),
    ).filter(Boolean);

    if (!memberCollectionIds.length) {
      return { success: true, data: { author, books: [] } };
    }

    // 2) Apply optional collection scope
    const targetCollectionIds = collectionId
      ? memberCollectionIds.includes(collectionId)
        ? [collectionId]
        : []
      : memberCollectionIds;

    if (!targetCollectionIds.length) {
      // If a specific collection was requested but user isn't a member, return empty
      return { success: true, data: { author, books: [] } };
    }

    // 4) Page query: visible books by this author in the scoped collections.
    const pageRows = await cloudDb
      .select({ book: books })
      .from(books)
      .innerJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
      .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
      .where(
        and(
          eq(bookAuthors.authorId, authorId),
          inArray(collectionBooks.collectionId, targetCollectionIds),
          ordering.where,
        ),
      )
      // Avoid duplicates if the book appears multiple times due to joins.
      .groupBy(books.id)
      .orderBy(...ordering.orderBy)
      .limit(limit + 1);

    const rows = pageRows
      .map((r) => r.book)
      .filter((b): b is NonNullable<(typeof books)['$inferSelect']> => !!b);

    if (!rows.length) {
      return { success: true, data: { author, books: [], nextCursor: null } };
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const bookIds = page.map((b) => b.id).filter(Boolean);

    // 5) Attach authors (ordered)
    const allAuthorLinks = await cloudDb
      .select({
        bookId: bookAuthors.bookId,
        authorId: bookAuthors.authorId,
        position: bookAuthors.position,
      })
      .from(bookAuthors)
      .where(inArray(bookAuthors.bookId, bookIds));

    const allAuthorIds = Array.from(
      new Set(allAuthorLinks.map((l) => l.authorId)),
    ).filter(Boolean);

    const authorRows = allAuthorIds.length
      ? await cloudDb
          .select({ id: authors.id, name: authors.name })
          .from(authors)
          .where(inArray(authors.id, allAuthorIds))
      : [];

    const authorNameById = new Map(authorRows.map((a) => [a.id, a.name]));

    const linksByBookId = new Map<string, typeof allAuthorLinks>();
    for (const link of allAuthorLinks) {
      const list = linksByBookId.get(link.bookId) ?? [];
      list.push(link);
      linksByBookId.set(link.bookId, list);
    }

    // 7) Attach publisher + series display info
    const publisherIds = Array.from(
      new Set(page.map((b) => b.publisherId).filter(Boolean)),
    ) as string[];

    const seriesIds = Array.from(
      new Set(page.map((b) => b.seriesId).filter(Boolean)),
    ) as string[];

    const publisherRows = publisherIds.length
      ? await cloudDb
          .select({ id: publishers.id, name: publishers.name })
          .from(publishers)
          .where(inArray(publishers.id, publisherIds))
      : [];

    const seriesRows = seriesIds.length
      ? await cloudDb
          .select({ id: series.id, name: series.name })
          .from(series)
          .where(inArray(series.id, seriesIds))
      : [];

    const publisherById = new Map(publisherRows.map((p) => [p.id, p]));
    const seriesById = new Map(seriesRows.map((s) => [s.id, s]));

    const out = page.map((b) => {
      const links = (linksByBookId.get(b.id) ?? []).slice();
      links.sort((a, c) => {
        const aPos = typeof a.position === 'number' ? a.position : 10_000;
        const cPos = typeof c.position === 'number' ? c.position : 10_000;
        return aPos - cPos;
      });

      const authorNames = links
        .map((l) => (l.authorId ? authorNameById.get(l.authorId) : undefined))
        .filter((n): n is string => typeof n === 'string' && n.length > 0);

      const authorsOut = links
        .map((l) => {
          const name = l.authorId ? authorNameById.get(l.authorId) : undefined;
          if (!l.authorId || !name) return null;
          return { id: l.authorId, name };
        })
        .filter(
          (a): a is { id: string; name: string } =>
            !!a && typeof a.id === 'string' && typeof a.name === 'string',
        );

      // Back-compat: keep the first author in `author`
      const author = authorNames[0];

      const publisher = b.publisherId
        ? (publisherById.get(b.publisherId) ?? null)
        : null;

      const seriesOut = b.seriesId
        ? (seriesById.get(b.seriesId) ?? null)
        : null;

      return {
        ...b,
        author,
        authorNames,
        authors: authorsOut,
        publisher,
        series: seriesOut,
      };
    });

    const last = out[out.length - 1];
    const nextCursor = nextBookCursor(sort, hasMore, last);

    return { success: true, data: { author, books: out, nextCursor } };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors (401/400/404) thrown above
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(error, 'GET /api/authors/:id/books: failed');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch author books',
    });
  }
});
