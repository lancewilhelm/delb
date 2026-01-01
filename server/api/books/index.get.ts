import { eq, inArray } from "drizzle-orm";
import { cloudDb } from "~~/server/utils/db/cloud";
import { books, collectionBooks, collectionMembers } from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

export default defineEventHandler(async (event) => {
  logger.debug("GET /api/books");

  // Keep consistent with the rest of the app: require an authenticated user
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return {
      success: false,
      message: "Unauthorized",
    };
  }

  const userId = session.user.id;

  // Optional query param:
  // - collectionId=<id> fetches books only from that collection (if user is a member)
  // - omit collectionId to fetch books from all collections the user is a member of
  const { collectionId } = getQuery(event) as { collectionId?: string };

  try {
    // Find collections the user is a member of
    const memberships = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, userId));

    const memberCollectionIds = Array.from(
      new Set(memberships.map((m) => m.collectionId)),
    ).filter(Boolean);

    if (!memberCollectionIds.length) {
      return {
        success: true,
        data: {
          books: [],
        },
      };
    }

    // Determine which collections to use for the query
    const targetCollectionIds = collectionId
      ? memberCollectionIds.includes(collectionId)
        ? [collectionId]
        : []
      : memberCollectionIds;

    // If a specific collection was requested but the user isn't a member, return empty
    // (avoid leaking existence of collections).
    if (!targetCollectionIds.length) {
      return {
        success: true,
        data: {
          books: [],
        },
      };
    }

    // Pull all book ids from the target collections
    const bookLinks = await cloudDb
      .select({ bookId: collectionBooks.bookId })
      .from(collectionBooks)
      .where(inArray(collectionBooks.collectionId, targetCollectionIds));

    const bookIds = Array.from(new Set(bookLinks.map((r) => r.bookId))).filter(
      Boolean,
    );

    if (!bookIds.length) {
      return {
        success: true,
        data: {
          books: [],
        },
      };
    }

    // Fetch each book by id (lean/simple approach; small N expected in v1)
    const bookRows = await Promise.all(
      bookIds.map((id) =>
        cloudDb.select().from(books).where(eq(books.id, id)).limit(1),
      ),
    );

    const rows = bookRows.map((r) => r[0]).filter(Boolean);

    // Keep previous behavior: newest first
    rows.sort((a, b) => {
      const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    return {
      success: true,
      data: {
        books: rows,
      },
    };
  } catch (error) {
    logger.error(error, "GET /api/books: Error fetching books");
    setResponseStatus(event, 500);
    return {
      success: false,
      message: "Failed to fetch books",
    };
  }
});
