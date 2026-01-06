import { and, asc, countDistinct, eq } from "drizzle-orm";
import { cloudDb } from "~~/server/utils/db/cloud";
import {
  books,
  collectionBooks,
  collectionMembers,
  series as seriesTable,
} from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

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
  logger.debug("GET /api/series");

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: "Unauthorized" };
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
      return { success: false, message: "Forbidden" };
    }
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

    const out = rows.map((r) => ({
      id: r.id,
      name: r.name,
      bookCount:
        typeof r.bookCount === "number" ? r.bookCount : Number(r.bookCount),
    }));

    return {
      success: true,
      data: {
        series: out,
      },
    };
  } catch (error: unknown) {
    logger.error(error, "GET /api/series: failed");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to load series",
    });
  }
});
