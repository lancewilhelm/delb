import { and, asc, eq, inArray } from "drizzle-orm";
import { cloudDb } from "~~/server/utils/db/cloud";
import {
  authors,
  bookAuthors,
  bookFiles,
  books,
  collectionBooks,
  collectionMembers,
  publishers,
  series,
} from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

export default defineEventHandler(async (event) => {
  logger.debug("GET /api/books/:id");

  // Require auth (consistent with other book endpoints)
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const userId = session.user.id;

  const id = getRouterParam(event, "id");
  if (!id) {
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
      .select()
      .from(books)
      .innerJoin(
        collectionBooks,
        and(eq(collectionBooks.bookId, books.id), eq(books.id, id)),
      )
      .where(inArray(collectionBooks.collectionId, memberCollectionIds))
      .limit(1);

    const book = visible[0]?.books;

    if (!book) {
      // Use 404 to avoid leaking existence of books the user cannot access.
      throw createError({ statusCode: 404, statusMessage: "Book not found" });
    }

    // Publisher + Series (denormalized objects for the detail page)
    const publisher = book.publisherId
      ? ((
          await cloudDb
            .select({ id: publishers.id, name: publishers.name })
            .from(publishers)
            .where(eq(publishers.id, book.publisherId))
            .limit(1)
        )[0] ?? null)
      : null;

    const seriesRow = book.seriesId
      ? ((
          await cloudDb
            .select({ id: series.id, name: series.name })
            .from(series)
            .where(eq(series.id, book.seriesId))
            .limit(1)
        )[0] ?? null)
      : null;

    const seriesOut = seriesRow
      ? { ...seriesRow, index: book.seriesIndex ?? null }
      : null;

    // Authors for this book (ordered)
    const authorLinks = await cloudDb
      .select({
        authorId: bookAuthors.authorId,
        position: bookAuthors.position,
        name: authors.name,
      })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, id))
      .orderBy(asc(bookAuthors.position), asc(authors.name));

    const bookAuthorsOut = authorLinks.map((a) => ({
      id: a.authorId,
      name: a.name,
      position: a.position ?? null,
    }));

    // Files for this book (all known formats)
    const files = await cloudDb
      .select()
      .from(bookFiles)
      .where(eq(bookFiles.bookId, id));

    return {
      success: true,
      data: {
        book: {
          ...book,
          publisher,
          series: seriesOut,
        },
        authors: bookAuthorsOut,
        files,
      },
    };
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

    logger.error(error, "GET /api/books/:id: Error fetching book");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to fetch book",
    });
  }
});
