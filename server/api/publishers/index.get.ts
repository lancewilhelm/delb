import { and, asc, countDistinct, eq, inArray } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  publishers,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/publishers?collectionId=<optional>
 *
 * Returns all publishers the current user can access, with per-publisher book counts.
 *
 * Access control:
 * - Requires an authenticated user
 * - Only returns publishers that have at least one book in collections the user is a member of
 * - If `collectionId` is provided, results are scoped to that one collection (user must be a member)
 *
 * Response shape:
 * {
 *   success: true,
 *   data: {
 *     publishers: Array<{ id: string; name: string; bookCount: number }>
 *   }
 * }
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/publishers');

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const { collectionId } = getQuery(event) as { collectionId?: string };

  // If a collectionId is provided, verify membership to avoid leaking metadata.
  if (collectionId) {
    const membership = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(
        and(
          eq(collectionMembers.collectionId, collectionId),
          eq(collectionMembers.userId, session.user.id),
        ),
      )
      .limit(1);

    if (!membership[0]) {
      setResponseStatus(event, 403);
      return { success: false, message: 'Forbidden' };
    }
  }

  function coverThumbUrl(coverImagePath: string) {
    return `/api/media/covers/${coverImagePath.replace(/^library\//, '')}`;
  }

  try {
    /**
     * We want:
     * - publishers visible via books in collections the user can access
     * - optional scope to one collection
     * - count distinct books per publisher
     *
     * Joins:
     * publishers <- books -> collectionBooks -> collectionMembers
     */
    const rows = await cloudDb
      .select({
        id: publishers.id,
        name: publishers.name,
        bookCount: countDistinct(books.id),
      })
      .from(publishers)
      .innerJoin(books, eq(books.publisherId, publishers.id))
      .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
      .innerJoin(
        collectionMembers,
        eq(collectionMembers.collectionId, collectionBooks.collectionId),
      )
      .where(
        and(
          eq(collectionMembers.userId, session.user.id),
          collectionId
            ? eq(collectionBooks.collectionId, collectionId)
            : // No additional filter when not scoped to one collection.
              // Keep a single `and(...)` shape with a tautology.
              eq(collectionMembers.userId, session.user.id),
        ),
      )
      .groupBy(publishers.id, publishers.name)
      .orderBy(asc(publishers.name));

    const outBase = rows.map((r) => ({
      id: r.id,
      name: r.name,
      // SQLite returns integers for COUNT; coerce defensively
      bookCount: typeof r.bookCount === 'number' ? r.bookCount : Number(r.bookCount),
    }));

    const publisherIds = outBase.map((p) => p.id).filter(Boolean);

    const bookRows =
      publisherIds.length > 0
        ? await cloudDb
            .select({
              publisherId: books.publisherId,
              bookId: books.id,
              title: books.title,
              coverImagePath: books.coverImagePath,
            })
            .from(books)
            .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
            .innerJoin(
              collectionMembers,
              eq(collectionMembers.collectionId, collectionBooks.collectionId),
            )
            .where(
              and(
                inArray(books.publisherId, publisherIds),
                eq(collectionMembers.userId, session.user.id),
                collectionId ? eq(collectionBooks.collectionId, collectionId) : undefined,
              ),
            )
            .groupBy(books.publisherId, books.id, books.title, books.coverImagePath)
            .orderBy(asc(books.publisherId), asc(books.title), asc(books.id))
        : [];

    const booksByPublisherId = new Map<
      string,
      Array<{
        id: string;
        title: string;
        coverImagePath: string | null;
        coverThumbnailUrl: string | null;
      }>
    >();

    for (const row of bookRows) {
      const pid = (row.publisherId ?? '').toString();
      const bid = (row.bookId ?? '').toString();
      const title = (row.title ?? '').toString();
      const coverImagePathRaw = (row.coverImagePath ?? '').toString().trim();
      const coverImagePath = coverImagePathRaw ? coverImagePathRaw : null;

      if (!pid || !bid) continue;

      const list = booksByPublisherId.get(pid) ?? [];
      list.push({
        id: bid,
        title,
        coverImagePath,
        coverThumbnailUrl: coverImagePath ? coverThumbUrl(coverImagePath) : null,
      });
      booksByPublisherId.set(pid, list);
    }

    const out = outBase.map((p) => ({
      ...p,
      books: booksByPublisherId.get(p.id) ?? [],
    }));

    return {
      success: true,
      data: {
        publishers: out,
      },
    };
  } catch (error: unknown) {
    logger.error(error, 'GET /api/publishers: failed');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to load publishers',
    });
  }
});
