import path from "node:path";
import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import {
  bookFiles,
  books,
  collectionBooks,
  bookAuthors,
  bookTags,
  bookIdentifiers,
  userBookStatus,
  bookRatings,
  bookNotes,
} from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

/**
 * DELETE /api/books/:id
 *
 * Admin-only endpoint that deletes:
 * - the canonical book row from the database
 * - associated rows (files, links, per-user state)
 * - associated files from disk under `<projectRoot>/books`
 *
 * Notes:
 * - File paths live in `book_files.relativePath` and cover path lives in `books.coverImagePath`
 *   (both typically prefixed with `books/...`).
 * - We resolve those safely under `<projectRoot>/books` and block path traversal.
 */
export default defineEventHandler(async (event) => {
  logger.debug("DELETE /api/books/:id");

  // Ensure the user is authenticated and is an admin/owner
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (
    !session ||
    (session.user.role !== "admin" && session.user.role !== "owner")
  ) {
    setResponseStatus(event, 401);
    return { success: false, message: "Unauthorized" };
  }

  const id = getRouterParam(event, "id");
  if (!id) {
    setResponseStatus(event, 400);
    return { success: false, message: "Missing book id" };
  }

  try {
    // Load the book first so we know what to delete from disk
    const rows = await cloudDb.select().from(books).where(eq(books.id, id));
    const book = rows[0];

    if (!book) {
      setResponseStatus(event, 404);
      return { success: false, message: "Book not found" };
    }

    // Load associated files (formats)
    const fileRows = await cloudDb
      .select()
      .from(bookFiles)
      .where(eq(bookFiles.bookId, id));

    const booksBaseAbs = path.resolve(process.cwd(), "books");

    const resolveUnderBooks = (storedPath: string) => {
      // Stored paths usually look like: "books/Author/Title/file.ext"
      // Normalize to path relative to `<projectRoot>/books`
      const relFromBooks = storedPath.replace(/^books[\\/]/, "");
      const abs = path.resolve(booksBaseAbs, relFromBooks);

      const relToBase = path.relative(booksBaseAbs, abs);
      if (relToBase.startsWith("..") || relToBase.includes(`..${path.sep}`)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid path" });
      }

      return abs;
    };

    const coverAbs = book.coverImagePath
      ? resolveUnderBooks(book.coverImagePath)
      : null;

    // 1) Delete files from disk (best-effort)
    if (coverAbs) {
      try {
        await rm(coverAbs, { force: true });
      } catch (e) {
        logger.warn(
          e,
          "DELETE /api/books/:id: Failed to delete cover (continuing)",
        );
      }
    }

    for (const f of fileRows) {
      if (!f.relativePath) continue;
      const fileAbs = resolveUnderBooks(f.relativePath);
      try {
        await rm(fileAbs, { force: true });
      } catch (e) {
        logger.warn(
          e,
          "DELETE /api/books/:id: Failed to delete a book file (continuing)",
        );
      }
    }

    // 2) Delete associated DB rows (ordering chosen to avoid foreign key issues)
    await cloudDb.delete(collectionBooks).where(eq(collectionBooks.bookId, id));
    await cloudDb.delete(bookFiles).where(eq(bookFiles.bookId, id));
    await cloudDb.delete(bookAuthors).where(eq(bookAuthors.bookId, id));
    await cloudDb.delete(bookTags).where(eq(bookTags.bookId, id));
    await cloudDb.delete(bookIdentifiers).where(eq(bookIdentifiers.bookId, id));

    // per-user state
    await cloudDb.delete(userBookStatus).where(eq(userBookStatus.bookId, id));
    await cloudDb.delete(bookRatings).where(eq(bookRatings.bookId, id));
    await cloudDb.delete(bookNotes).where(eq(bookNotes.bookId, id));

    // 3) Delete the canonical book row
    await cloudDb.delete(books).where(eq(books.id, id));

    return { success: true };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(error, "DELETE /api/books/:id: Error deleting book");
    setResponseStatus(event, 500);
    return { success: false, message: "Internal server error" };
  }
});
