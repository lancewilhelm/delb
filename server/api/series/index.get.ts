import { and, asc, countDistinct, eq, inArray, sql } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  series as seriesTable,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/series?collectionId=<optional>
 *
 * Returns all series the current user can access, with per-series book counts.
 *
 * Access control:
 * - Requires an authenticated user
 * - Only returns series that have at least one book in collections the user is a member of
 * - If `collectionId` is provided, results are scoped to that one collection (must be a member)
 *
 * Response shape:
 * {
 *   success: true,
 *   data: {
 *     series: Array<{ id: string; name: string; bookCount: number }>
 *   }
 * }
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/series');

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
     * - series visible via books in collections the user can access
     * - optional scope to one collection
     * - count distinct books per series
     *
     * Joins:
     * series <- books -> collectionBooks -> collectionMembers
     *
     * Note:
     * - We only return series that are non-null on at least one accessible book.
     */
    const rows = await cloudDb
      .select({
        id: seriesTable.id,
        name: seriesTable.name,
        bookCount: countDistinct(books.id),
      })
      .from(seriesTable)
      .innerJoin(books, eq(books.seriesId, seriesTable.id))
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
              // Keep shape stable without using raw SQL literal.
              eq(collectionMembers.userId, session.user.id),
        ),
      )
      .groupBy(seriesTable.id, seriesTable.name)
      .orderBy(asc(seriesTable.name));

    const outBase = rows.map((r) => ({
      id: r.id,
      name: r.name,
      bookCount:
        typeof r.bookCount === 'number' ? r.bookCount : Number(r.bookCount),
    }));

    const seriesIds = outBase.map((s) => s.id).filter(Boolean);

    const coverRows =
      seriesIds.length > 0
        ? await cloudDb
            .select({
              seriesId: books.seriesId,
              bookId: books.id,
              title: books.title,
              coverImagePath: books.coverImagePath,
              seriesIndex: books.seriesIndex,
            })
            .from(books)
            .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
            .innerJoin(
              collectionMembers,
              eq(collectionMembers.collectionId, collectionBooks.collectionId),
            )
            .where(
              and(
                inArray(books.seriesId, seriesIds),
                eq(collectionMembers.userId, session.user.id),
                collectionId
                  ? eq(collectionBooks.collectionId, collectionId)
                  : undefined,
              ),
            )
            // Avoid duplicates when the same book is in multiple collections within scope.
            .groupBy(books.id)
            // Order thumbnails by series_index (nulls last), then title for stability.
            .orderBy(
              asc(sql`COALESCE(${books.seriesIndex}, 999999)`),
              asc(books.title),
              asc(books.id),
            )
        : [];

    const booksBySeriesId = new Map<
      string,
      Array<{
        id: string;
        title: string;
        seriesIndex: number | null;
        coverImagePath: string | null;
        coverThumbnailUrl: string | null;
      }>
    >();

    for (const row of coverRows) {
      const sid = (row.seriesId ?? '').toString();
      const bid = (row.bookId ?? '').toString();
      const title = (row.title ?? '').toString();
      const coverImagePathRaw = (row.coverImagePath ?? '').toString().trim();
      const coverImagePath = coverImagePathRaw ? coverImagePathRaw : null;
      const seriesIndex =
        typeof row.seriesIndex === 'number'
          ? row.seriesIndex
          : row.seriesIndex ?? null;

      if (!sid || !bid) continue;

      const list = booksBySeriesId.get(sid) ?? [];
      list.push({
        id: bid,
        title,
        seriesIndex,
        coverImagePath,
        coverThumbnailUrl: coverImagePath ? coverThumbUrl(coverImagePath) : null,
      });

      booksBySeriesId.set(sid, list);
    }

    const out = outBase.map((s) => ({
      ...s,
      books: booksBySeriesId.get(s.id) ?? [],
    }));

    return {
      success: true,
      data: {
        series: out,
      },
    };
  } catch (error: unknown) {
    logger.error(error, 'GET /api/series: failed');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to load series',
    });
  }
});
