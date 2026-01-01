import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { eq } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import {
  authors,
  bookAuthors,
  bookFiles,
  books,
  collectionMembers,
  collectionBooks,
} from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

import { parseEpubMetadataFromBuffer } from "~~/server/utils/books/epub";
import { extractAndStoreEpubCover } from "~~/server/utils/books/epub-cover";
import {
  buildBookRelativePath,
  resolveDataPath,
  toSafePathSegment,
} from "~~/server/utils/books/fs";

/**
 * Get the extension of a filename.
 * @param filename
 * @returns
 */
function getExtension(filename: string): string {
  const ext = path.extname(filename || "").toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

/**
 * Ensure that the filename is an EPUB file.
 * @param filename
 */
function ensureEpub(filename: string) {
  const ext = getExtension(filename);
  if (ext !== "epub") {
    throw createError({
      statusCode: 400,
      statusMessage: "Only .epub uploads are supported in this MVP",
    });
  }
}

type MultipartFilePart = {
  name?: string;
  filename?: string;
  type?: string;
  data?: Buffer;
};

/**
 * Ensure the user can add books to every target collection.
 */
async function assertCanUploadToCollections(opts: {
  userId: string;
  collectionIds: string[];
}) {
  const uniqueIds = Array.from(new Set(opts.collectionIds)).filter(Boolean);
  if (!uniqueIds.length) {
    throw createError({
      statusCode: 400,
      statusMessage: "At least one target collection is required",
    });
  }

  const memberships = await cloudDb
    .select()
    .from(collectionMembers)
    .where(eq(collectionMembers.userId, opts.userId));

  const roleByCollectionId = new Map(
    memberships.map((m) => [m.collectionId, m.role] as const),
  );

  const forbidden = uniqueIds.filter((id) => {
    const role = roleByCollectionId.get(id);
    return role !== "owner" && role !== "editor";
  });

  if (forbidden.length) {
    throw createError({
      statusCode: 403,
      statusMessage:
        "You do not have permission to upload to one or more selected collections",
    });
  }
}

/**
 * Find or create an author by name (lean v1: unique by exact name).
 */
async function findOrCreateAuthorByName(name: string) {
  const existing = await cloudDb
    .select()
    .from(authors)
    .where(eq(authors.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(authors).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

/**
 * Process a single EPUB upload.
 * @param filePart
 * @param userId
 * @param collectionIds
 * @returns object containing the book's metadata and the path to the cover image
 */
async function processOneEpubUpload(
  filePart: MultipartFilePart,
  input: { userId: string; collectionIds: string[] },
) {
  if (!filePart.filename || !filePart.data) {
    throw createError({ statusCode: 400, statusMessage: "Missing EPUB file" });
  }

  ensureEpub(filePart.filename);

  // Parse EPUB metadata
  const fallbackTitle = path.basename(
    filePart.filename,
    path.extname(filePart.filename),
  );
  const meta = await parseEpubMetadataFromBuffer(filePart.data, {
    fallbackTitle,
  });

  const authorName = meta.author || "Unknown Author";
  const title = meta.title || fallbackTitle || "Untitled";

  const safeAuthor = toSafePathSegment(authorName, "Unknown Author");
  const safeTitle = toSafePathSegment(title, "Untitled");

  // Store as: books/{author}/{title}/{title}.epub
  const epubRelativePath = buildBookRelativePath({
    author: safeAuthor,
    title: safeTitle,
    filename: `${safeTitle}.epub`,
  });

  const epubAbsolutePath = resolveDataPath(epubRelativePath);
  const bookDirAbsolute = path.dirname(epubAbsolutePath);

  // Ensure directories exist then write file
  await mkdir(bookDirAbsolute, { recursive: true });
  await writeFile(epubAbsolutePath, filePart.data);

  // Best-effort cover extraction (does not fail the upload if cover is missing)
  // We store a small WebP thumbnail to keep bandwidth/disk usage low.
  let coverImagePath: string | null = null;
  try {
    const coverRelativePath = buildBookRelativePath({
      author: safeAuthor,
      title: safeTitle,
      filename: "cover.webp",
    });

    const extracted = await extractAndStoreEpubCover({
      epubFilePath: epubAbsolutePath,
      outputDirAbsolute: bookDirAbsolute,
      outputRelativePathPosix: coverRelativePath,
      maxWidth: 320,
      webpQuality: 80,
    });

    coverImagePath = extracted?.relativePath ?? null;
  } catch (error) {
    logger.debug(
      error,
      "POST /api/books/upload: Failed to extract cover (continuing without cover)",
    );
    coverImagePath = null;
  }

  const id = crypto.randomUUID();
  const now = new Date();

  // Create canonical book record
  await cloudDb.insert(books).values({
    id,
    title,
    description: (meta.description || null) as string | null,
    published: (meta.published || null) as string | null,
    language: (meta.language || null) as string | null,
    coverImagePath,
    createdByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
  });

  // Attach author (lean v1: one author from EPUB metadata)
  const author = await findOrCreateAuthorByName(authorName);
  await cloudDb.insert(bookAuthors).values({
    bookId: id,
    authorId: author.id,
    position: 1,
  });

  // Attach EPUB file
  await cloudDb.insert(bookFiles).values({
    id: crypto.randomUUID(),
    bookId: id,
    format: "epub",
    relativePath: epubRelativePath,
    createdAt: now,
  });

  // Add to collections
  for (const collectionId of input.collectionIds) {
    await cloudDb.insert(collectionBooks).values({
      collectionId,
      bookId: id,
      addedByUserId: input.userId,
      addedAt: now,
    });
  }

  return {
    id,
    title,
    author: authorName,
    format: "epub",
    relativePath: epubRelativePath,
    coverImagePath,
    createdAt: now,
  };
}

export default defineEventHandler(async (event) => {
  logger.debug("POST /api/books/upload");

  // Require auth (consistent with the app's home page)
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const userId = session.user.id;

  // Parse multipart form
  const form = await readMultipartFormData(event);
  if (!form?.length) {
    throw createError({ statusCode: 400, statusMessage: "Missing form data" });
  }

  // Allow selecting one or more target collections.
  // v1: accept one or more `collectionId` fields as part of the multipart form:
  //   form.append("collectionId", "<id>")
  const collectionIds = form
    .filter((p) => p.name === "collectionId")
    .map((p) => (typeof p.data === "string" ? p.data : p.data?.toString()))
    .filter((x): x is string => typeof x === "string" && x.length > 0);

  // If client didn't specify collections, fail explicitly (for now).
  // Once you add "default personal collection" creation, you can resolve that here.
  await assertCanUploadToCollections({ userId, collectionIds });

  // Find all file parts (client may send multiple "file" entries)
  const fileParts = form.filter(
    (p) => p.type && p.filename && p.data,
  ) as MultipartFilePart[];

  if (!fileParts.length) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing EPUB file(s)",
    });
  }

  const results: Array<{
    success: boolean;
    book?: unknown;
    filename?: string;
    error?: string;
  }> = [];

  for (const part of fileParts) {
    try {
      const book = await processOneEpubUpload(part, { userId, collectionIds });
      results.push({ success: true, book, filename: part.filename });
    } catch (err: unknown) {
      logger.error(err, "POST /api/books/upload: Failed to process one upload");

      const e = err as {
        data?: { message?: string };
        statusMessage?: string;
        message?: string;
      };

      results.push({
        success: false,
        filename: part.filename,
        error:
          e?.data?.message ||
          e?.statusMessage ||
          e?.message ||
          "Failed to upload file",
      });
    }
  }

  const uploaded = results.filter((r) => r.success).map((r) => r.book);

  return {
    success: true,
    data: {
      uploaded,
      results,
    },
  };
});
