import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";

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
 * POST /api/books/:id/cover
 *
 * Admin-only endpoint that accepts an uploaded image and stores it as:
 *   library/<author(s)>/<title (id8)>/cover.webp
 *
 * Then updates `books.coverImagePath` accordingly.
 *
 * Request: multipart/form-data with a single file field named `file`.
 *
 * Security:
 * - Requires authenticated admin/owner.
 * - Ensures the requesting user can "see" the book via collection membership
 *   (same visibility model as GET /api/books/:id).
 * - Resolves and writes the cover next to the stored book file inside `library/`.
 * - Blocks path traversal by ensuring writes stay within `<projectRoot>/library`.
 *
 * Notes:
 * - The canonical directory for a book is derived from an existing `book_files.relativePath`
 *   (e.g. `library/<author(s)>/<title (id8)>/<title>.epub`).
 * - Always stores as `cover.webp` (overwrite semantics).
 */
export default defineEventHandler(async (event) => {
  logger.debug("POST /api/books/:id/cover");

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (
    !session ||
    (session.user.role !== "admin" && session.user.role !== "owner")
  ) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const userId = session.user.id;

  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Missing book id" });
  }

  // Parse multipart form
  const form = await readMultipartFormData(event);
  if (!form?.length) {
    throw createError({ statusCode: 400, statusMessage: "Missing form data" });
  }

  const filePart = form.find((p) => p.name === "file" && p.data) as
    | {
        name?: string;
        filename?: string;
        type?: string;
        data?: Buffer;
      }
    | undefined;

  if (!filePart?.data) {
    throw createError({ statusCode: 400, statusMessage: "Missing cover file" });
  }

  try {
    // Enforce visibility: user must be a member of at least one collection that contains this book.
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

    // Find a canonical file path for this book to determine its directory.
    // Prefer EPUB if present; else use any existing format.
    const files = await cloudDb
      .select()
      .from(bookFiles)
      .where(eq(bookFiles.bookId, id));

    if (!files.length) {
      throw createError({
        statusCode: 409,
        statusMessage: "Book has no files; cannot determine storage directory",
      });
    }

    const preferred =
      files.find((f) => (f.format || "").toLowerCase() === "epub") ?? files[0];

    if (!preferred?.relativePath) {
      throw createError({
        statusCode: 409,
        statusMessage: "Book file path missing; cannot store cover",
      });
    }

    // Resolve target directory under <projectRoot>/library
    const libraryBaseAbs = path.resolve(process.cwd(), "library");

    // relativePath is stored like: "library/<author(s)>/<title (id8)>/<file>"
    const relFromLibrary = preferred.relativePath.replace(/^library[\\/]/, "");
    const bookFileAbs = path.resolve(libraryBaseAbs, relFromLibrary);

    // Path traversal protection for the source-derived path
    const relToBase = path.relative(libraryBaseAbs, bookFileAbs);
    if (relToBase.startsWith("..") || relToBase.includes(`..${path.sep}`)) {
      logger.warn(
        { id, relativePath: preferred.relativePath },
        "POST /api/books/:id/cover: blocked path traversal attempt",
      );
      throw createError({ statusCode: 400, statusMessage: "Invalid path" });
    }

    const bookDirAbs = path.dirname(bookFileAbs);
    const coverAbs = path.join(bookDirAbs, "cover.webp");

    // Convert uploaded image to webp. Keep it reasonably sized.
    // (You can tune these later; these match the “small thumbnail cover” idea.)
    const webp = await sharp(filePart.data)
      .rotate() // respect EXIF orientation
      .resize({
        width: 640,
        height: 640,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();

    await mkdir(bookDirAbs, { recursive: true });
    await writeFile(coverAbs, webp);

    // Compute DB path (posix-style) for coverImagePath.
    // We keep it relative and stable: library/<author>/<title>/cover.webp
    const coverRelPosix = path.posix.join(
      "library",
      ...path.relative(libraryBaseAbs, coverAbs).split(path.sep),
    );

    await cloudDb
      .update(books)
      .set({ coverImagePath: coverRelPosix, updatedAt: new Date() })
      .where(eq(books.id, id));

    return {
      success: true,
      data: {
        coverImagePath: coverRelPosix,
      },
    };
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

    logger.error(error, "POST /api/books/:id/cover: failed to upload cover");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to upload cover",
    });
  }
});
