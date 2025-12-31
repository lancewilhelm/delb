import path from "node:path";
import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import { books } from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

/**
 * DELETE /api/books/:id
 *
 * Admin-only endpoint that deletes:
 * - the book row from the database
 * - the associated files from disk under `<projectRoot>/books`
 *
 * Notes:
 * - Book paths are stored in DB as `relativePath` and `coverImagePath`
 *   (both typically prefixed with `books/...`).
 * - We resolve those safely under `<projectRoot>/books` and block path traversal.
 * - If the book directory becomes empty after deletion, we attempt to remove it
 *   (best-effort).
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

    const fileAbs = book.relativePath
      ? resolveUnderBooks(book.relativePath)
      : null;
    const coverAbs = book.coverImagePath
      ? resolveUnderBooks(book.coverImagePath)
      : null;

    // Determine the book directory (best effort; based on the EPUB path)
    const bookDirAbs = fileAbs ? path.dirname(fileAbs) : null;

    // 1) Delete DB row first or last? Prefer deleting files first to avoid orphaning
    // files if DB delete succeeds but filesystem fails. We'll delete files best-effort
    // and still remove DB record.
    //
    // Delete cover (best-effort)
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

    // Delete book file (best-effort)
    if (fileAbs) {
      try {
        await rm(fileAbs, { force: true });
      } catch (e) {
        logger.warn(
          e,
          "DELETE /api/books/:id: Failed to delete book file (continuing)",
        );
      }
    }

    // Delete the book directory if it's now empty (best-effort)
    if (bookDirAbs) {
      try {
        // Only remove if empty: rm without recursive will fail if not empty.
        await rm(bookDirAbs, { force: true });
      } catch {
        // ignore (likely not empty, or doesn't exist)
      }
    }

    // 2) Delete DB row
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
