import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { cloudDb } from "~~/server/utils/db/cloud";
import { books } from "~/utils/db/schema";
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
 * Process a single EPUB upload.
 * @param filePart
 * @returns object containing the book's metadata and the path to the cover image
 */
async function processOneEpubUpload(filePart: MultipartFilePart) {
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

  const author = meta.author || "Unknown Author";
  const title = meta.title || fallbackTitle || "Untitled";

  const safeAuthor = toSafePathSegment(author, "Unknown Author");
  const safeTitle = toSafePathSegment(title, "Untitled");

  // Store as: data/books/{author}/{title}/{title}.epub
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

  // Insert DB record
  const id = crypto.randomUUID();
  const now = new Date();

  await cloudDb.insert(books).values({
    id,
    title,
    author,
    format: "epub",
    relativePath: epubRelativePath,
    coverImagePath,

    // Persist extended metadata (best-effort)
    description: (meta.description || null) as string | null,
    publisher: (meta.publisher || null) as string | null,
    published: (meta.published || null) as string | null,
    language: (meta.language || null) as string | null,
    identifier: (meta.identifier || null) as string | null,

    createdAt: now,
  });

  return {
    id,
    title,
    author,
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

  // Parse multipart form
  const form = await readMultipartFormData(event);
  if (!form?.length) {
    throw createError({ statusCode: 400, statusMessage: "Missing form data" });
  }

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
      const book = await processOneEpubUpload(part);
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
