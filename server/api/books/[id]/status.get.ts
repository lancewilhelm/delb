import { and, eq, inArray } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookStatus,
  USER_BOOK_STATUSES,
  type UserBookStatusValue,
} from "~/utils/db/schema";
import { auth } from "~/utils/auth";
import { logger } from "~/utils/logger";

/**
 * GET /api/books/:id/status
 *
 * Returns the authenticated user's (mutually-exclusive) status for a book,
 * or null when unset.
 *
 * Access control:
 * - Requires authentication
 * - Uses the same visibility model as GET /api/books/:id:
 *   the book must be present in at least one collection the user is a member of.
 *
 * Response:
 * - { success: true, data: { status: UserBookStatusValue | null } }
 */
export default defineEventHandler(async (event) => {
  logger.debug("GET /api/books/:id/status");

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const userId = session.user.id;

  const bookId = getRouterParam(event, "id");
  if (!bookId) {
    throw createError({ statusCode: 400, statusMessage: "Missing book id" });
  }

  try {
    // Enforce visibility: user must be a member of at least one collection
    // that contains the requested book.
    const memberships = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, userId));

    const memberCollectionIds = Array.from(
      new Set(memberships.map((m) => m.collectionId)),
    ).filter(Boolean);

    if (!memberCollectionIds.length) {
      throw createError({ statusCode: 404, statusMessage: "Book not found" });
    }

    const visible = await cloudDb
      .select({ id: books.id })
      .from(books)
      .innerJoin(
        collectionBooks,
        and(eq(collectionBooks.bookId, books.id), eq(books.id, bookId)),
      )
      .where(inArray(collectionBooks.collectionId, memberCollectionIds))
      .limit(1);

    if (!visible[0]?.id) {
      // Use 404 to avoid leaking existence of books the user cannot access.
      throw createError({ statusCode: 404, statusMessage: "Book not found" });
    }

    const row =
      (
        await cloudDb
          .select({ status: userBookStatus.status })
          .from(userBookStatus)
          .where(
            and(
              eq(userBookStatus.userId, userId),
              eq(userBookStatus.bookId, bookId),
            ),
          )
          .limit(1)
      )[0] ?? null;

    const statusRaw = row?.status ?? null;

    // Defensive validation: if older/unknown statuses exist (e.g. before list changed),
    // treat them as null instead of breaking the UI.
    const status =
      statusRaw && (USER_BOOK_STATUSES as readonly string[]).includes(statusRaw)
        ? (statusRaw as UserBookStatusValue)
        : null;

    return { success: true, data: { status } };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors (401/400/404) thrown above
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(error, "GET /api/books/:id/status: Error fetching status");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to fetch status",
    });
  }
});
