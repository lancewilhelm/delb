import { and, asc, countDistinct, eq } from "drizzle-orm";
import { cloudDb } from "~~/server/utils/db/cloud";
import {
  authors,
  bookAuthors,
  books,
  collectionBooks,
  collectionMembers,
} from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

/**
 * GET /api/authors?collectionId=<optional>
 *
 * Returns all authors the current user can access, with per-author book counts.
 *
 * Access control:
 * - Requires an authenticated user
 * - Only returns authors that have at least one book in collections the user is a member of
 * - If `collectionId` is provided, results are scoped to that one collection (must be a member)
 *
 * Response shape:
 * {
 *   success: true,
 *   data: {
 *     authors: Array<{ id: string; name: string; bookCount: number }>
 *   }
 * }
 */
export default defineEventHandler(async (event) => {
  logger.debug("GET /api/authors");

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
     * - authors visible via books in collections the user can access
     * - optional scope to one collection
     * - count distinct books per author
     *
     * Joins:
     * authors <- bookAuthors -> books -> collectionBooks -> collectionMembers
     */
    const rows = await cloudDb
      .select({
        id: authors.id,
        name: authors.name,
        bookCount: countDistinct(books.id),
      })
      .from(authors)
      .innerJoin(bookAuthors, eq(bookAuthors.authorId, authors.id))
      .innerJoin(books, eq(books.id, bookAuthors.bookId))
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
              // This is intentionally a tautology so we can keep a single `and(...)` shape.
              eq(collectionMembers.userId, session.user.id),
        ),
      )
      .groupBy(authors.id, authors.name)
      .orderBy(asc(authors.name));

    const out = rows.map((r) => ({
      id: r.id,
      name: r.name,
      // SQLite returns integers for COUNT; coerce defensively
      bookCount:
        typeof r.bookCount === "number" ? r.bookCount : Number(r.bookCount),
    }));

    return {
      success: true,
      data: {
        authors: out,
      },
    };
  } catch (error: unknown) {
    logger.error(error, "GET /api/authors: failed");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to load authors",
    });
  }
});
