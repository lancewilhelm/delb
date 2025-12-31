import path from "node:path";
import { createReadStream } from "node:fs";

import { eq } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import { books } from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

/**
 * GET /api/books/:id/download
 *
 * Authenticated endpoint that streams the stored book file (EPUB for the MVP).
 *
 * Notes:
 * - Uses the book's `relativePath` (stored like `books/.../*.epub`) and resolves
 *   it safely under `<projectRoot>/books`.
 * - Includes path traversal protection.
 * - Sends Content-Disposition: attachment for download.
 */
export default defineEventHandler(async (event) => {
  logger.debug("GET /api/books/:id/download");

  // Require auth (consistent with other book endpoints)
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Missing book id" });
  }

  // Look up the book
  const rows = await cloudDb.select().from(books).where(eq(books.id, id));
  const book = rows[0];

  if (!book) {
    throw createError({ statusCode: 404, statusMessage: "Book not found" });
  }

  if (!book.relativePath) {
    throw createError({
      statusCode: 500,
      statusMessage: "Book file path missing",
    });
  }

  // Resolve the stored file path safely under <projectRoot>/books
  // Stored `relativePath` is currently like: books/<author>/<title>/<title>.epub
  const booksBaseAbs = path.resolve(process.cwd(), "books");
  const relFromBooks = book.relativePath.replace(/^books[\\/]/, "");
  const fileAbs = path.resolve(booksBaseAbs, relFromBooks);

  // Path traversal protection: must remain under booksBaseAbs
  const relToBase = path.relative(booksBaseAbs, fileAbs);
  if (relToBase.startsWith("..") || relToBase.includes(`..${path.sep}`)) {
    logger.warn(
      { id, relativePath: book.relativePath },
      "GET /api/books/:id/download: blocked path traversal attempt",
    );
    throw createError({ statusCode: 400, statusMessage: "Invalid path" });
  }

  // Only allow EPUB in the MVP
  const ext = path.extname(fileAbs).toLowerCase();
  if (ext !== ".epub") {
    throw createError({
      statusCode: 400,
      statusMessage: "Unsupported book format for download",
    });
  }

  // Provide a friendly filename
  const safe = (s: string) =>
    s
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();

  const filename = `${safe(book.title)} - ${safe(book.author)}.epub`;

  setHeader(event, "Content-Type", "application/epub+zip");
  setHeader(event, "Content-Disposition", `attachment; filename="${filename}"`);
  // For privacy, avoid caching by intermediaries.
  setHeader(event, "Cache-Control", "private, no-store");

  try {
    return sendStream(event, createReadStream(fileAbs));
  } catch (error: unknown) {
    logger.error(error, "GET /api/books/:id/download: failed to stream file");
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
});
