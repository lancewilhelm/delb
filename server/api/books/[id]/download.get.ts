import path from "node:path";
import { createReadStream } from "node:fs";

import { and, eq, inArray } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import {
  bookFiles,
  books,
  collectionBooks,
  collectionMembers,
} from "~/utils/db/schema";
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

  const userId = session.user.id;

  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Missing book id" });
  }

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
    // Avoid leaking existence
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
    throw createError({ statusCode: 404, statusMessage: "Book not found" });
  }

  // Choose a downloadable file (v1: prefer EPUB)
  const files = await cloudDb
    .select()
    .from(bookFiles)
    .where(and(eq(bookFiles.bookId, id), eq(bookFiles.format, "epub")))
    .limit(1);

  const file = files[0];

  if (!file?.relativePath) {
    throw createError({
      statusCode: 500,
      statusMessage: "Book file path missing",
    });
  }

  // Resolve the stored file path safely under <projectRoot>/books
  // Stored `relativePath` is currently like: books/<author>/<title>/<title>.epub
  const booksBaseAbs = path.resolve(process.cwd(), "books");
  const relFromBooks = file.relativePath.replace(/^books[\\/]/, "");
  const fileAbs = path.resolve(booksBaseAbs, relFromBooks);

  // Path traversal protection: must remain under booksBaseAbs
  const relToBase = path.relative(booksBaseAbs, fileAbs);
  if (relToBase.startsWith("..") || relToBase.includes(`..${path.sep}`)) {
    logger.warn(
      { id, relativePath: file.relativePath },
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

  const filename = `${safe(book.title)}.epub`;

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
