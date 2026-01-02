import { eq, inArray } from "drizzle-orm";
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

    // Attach author display info (v1: primary author = lowest position, else any)
    const authorLinks = await cloudDb
      .select({
        bookId: bookAuthors.bookId,
        authorId: bookAuthors.authorId,
        position: bookAuthors.position,
      })
      .from(bookAuthors)
      .where(inArray(bookAuthors.bookId, bookIds));

    const authorIds = Array.from(
      new Set(authorLinks.map((l) => l.authorId)),
    ).filter(Boolean);

    const authorRows = authorIds.length
      ? await cloudDb
          .select({ id: authors.id, name: authors.name })
          .from(authors)
          .where(inArray(authors.id, authorIds))
      : [];

    const authorNameById = new Map(authorRows.map((a) => [a.id, a.name]));

    const linksByBookId = new Map<string, typeof authorLinks>();
    for (const link of authorLinks) {
      const list = linksByBookId.get(link.bookId) ?? [];
      list.push(link);
      linksByBookId.set(link.bookId, list);
    }

    const rowsWithAuthor = rows.map((b) => {
      const links = (linksByBookId.get(b.id) ?? []).slice();
      links.sort((a, c) => {
        const aPos = typeof a.position === "number" ? a.position : 10_000;
        const cPos = typeof c.position === "number" ? c.position : 10_000;
        return aPos - cPos;
      });

      const primary = links[0];
      const author =
        (primary?.authorId && authorNameById.get(primary.authorId)) ||
        undefined;

      return {
        ...b,
        author,
      };
    });

    // Keep previous behavior: newest first
    rowsWithAuthor.sort((a, b) => {
      const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    return {
      success: true,
      data: {
        books: rowsWithAuthor,
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
