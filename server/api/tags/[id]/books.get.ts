import { and, eq, inArray } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  books,
  bookTags,
  collectionBooks,
  collectionMembers,
  publishers,
  series,
  tags,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/tags/:id/books?collectionId=<optional>
 *
 * Returns books for a given tag that the current user can access, plus the tag metadata.
 *
 * Access control:
 * - Requires an authenticated user
 * - Only returns books that exist in collections the user is a member of
 * - Optional `collectionId` further scopes results to that one collection (if user is a member)
 *
 * Response shape mirrors GET /api/books (list) enough for reuse in the UI:
 * - includes `authors` ({id,name}[]) + `authorNames` + legacy `author`
 * - includes `publisher` ({id,name}|null) and `series` ({id,name}|null)
 *
 * Additionally returns:
 * - `tag`: { id, name }
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/tags/:id/books');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const userId = session.user.id;

  const tagId = getRouterParam(event, 'id');
  if (!tagId) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Missing tag id' };
  }

  const { collectionId } = getQuery(event) as { collectionId?: string };

  try {
    // Fetch tag metadata (nice UX); does not leak books outside membership scope.
    const tagRow = await cloudDb
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(eq(tags.id, tagId))
      .limit(1);

    const tag = tagRow[0] ?? null;

    if (!tag) {
      throw createError({ statusCode: 404, statusMessage: 'Tag not found' });
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
      return { success: true, data: { tag, books: [] } };
    }

    // 2) Apply optional collection scope
    const targetCollectionIds = collectionId
      ? memberCollectionIds.includes(collectionId)
        ? [collectionId]
        : []
      : memberCollectionIds;

    // If a specific collection was requested but user isn't a member, return empty
    if (!targetCollectionIds.length) {
      return { success: true, data: { tag, books: [] } };
    }

    // 3) Get visible book ids from those collections
    const visibleBookLinks = await cloudDb
      .select({ bookId: collectionBooks.bookId })
      .from(collectionBooks)
      .where(inArray(collectionBooks.collectionId, targetCollectionIds));

    const visibleBookIds = Array.from(
      new Set(visibleBookLinks.map((r) => r.bookId)),
    ).filter(Boolean);

    if (!visibleBookIds.length) {
      return { success: true, data: { tag, books: [] } };
    }

    // 4) Find book ids with this tag, limited to visibility scope
    const taggedLinks = await cloudDb
      .select({ bookId: bookTags.bookId })
      .from(bookTags)
      .where(
        and(
          eq(bookTags.tagId, tagId),
          inArray(bookTags.bookId, visibleBookIds),
        ),
      );

    const taggedBookIds = Array.from(
      new Set(taggedLinks.map((r) => r.bookId)),
    ).filter(Boolean);

    if (!taggedBookIds.length) {
      return { success: true, data: { tag, books: [] } };
    }

    // 5) Fetch books (canonical rows)
    const bookRows = await cloudDb
      .select()
      .from(books)
      .where(inArray(books.id, taggedBookIds));

    if (!bookRows.length) {
      return { success: true, data: { tag, books: [] } };
    }

    const bookIds = bookRows.map((b) => b.id).filter(Boolean);

    // 6) Attach authors (ordered)
    const allAuthorLinks = await cloudDb
      .select({
        bookId: bookAuthors.bookId,
        authorId: bookAuthors.authorId,
        position: bookAuthors.position,
        name: authors.name,
      })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(inArray(bookAuthors.bookId, bookIds));

    const authorMap = new Map<
      string,
      Array<{ id: string; name: string; position: number | null }>
    >();

    for (const row of allAuthorLinks) {
      const list = authorMap.get(row.bookId) ?? [];
      list.push({
        id: row.authorId,
        name: row.name,
        position: row.position ?? null,
      });
      authorMap.set(row.bookId, list);
    }

    // 7) Attach publisher + series display info
    const publisherIds = Array.from(
      new Set(bookRows.map((b) => b.publisherId).filter(Boolean)),
    ) as string[];
    const seriesIds = Array.from(
      new Set(bookRows.map((b) => b.seriesId).filter(Boolean)),
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

    // 8) Shape output
    const out = bookRows.map((b) => {
      const authorLinks = (authorMap.get(b.id) ?? []).slice().sort((a, bb) => {
        const ap = a.position ?? 9999;
        const bp = bb.position ?? 9999;
        if (ap !== bp) return ap - bp;
        return a.name.localeCompare(bb.name);
      });

      const authorsOut = authorLinks.map((a) => ({ id: a.id, name: a.name }));
      const authorNames = authorsOut.map((a) => a.name);
      const author = authorNames.join(', ');

      const publisher =
        b.publisherId && publisherById.has(b.publisherId)
          ? publisherById.get(b.publisherId)!
          : null;

      const seriesOut =
        b.seriesId && seriesById.has(b.seriesId)
          ? seriesById.get(b.seriesId)!
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

    return { success: true, data: { tag, books: out } };
  } catch (error: unknown) {
    logger.error(error, 'GET /api/tags/:id/books: failed');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to load tag books',
    });
  }
});
