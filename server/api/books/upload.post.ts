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
import { resolveDataPath, toSafePathSegment } from "~~/server/utils/books/fs";
import { makeAuthorSortKey, makeTitleSortKey } from "~~/server/utils/sort/keys";
import { buildBookStorageRelativePath } from "~~/server/utils/books/storage/paths";

type SupportedBookFormat = "epub" | "pdf" | "mobi" | "azw3";
const SUPPORTED_BOOK_FORMATS: ReadonlyArray<SupportedBookFormat> = [
  "epub",
  "pdf",
  "mobi",
  "azw3",
];

/**
 * Get the extension of a filename.
 * @param filename
 * @returns
 */
function getExtension(filename: string): string {
  const ext = path.extname(filename || "").toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

function isSupportedBookFormat(ext: string): ext is SupportedBookFormat {
  return (SUPPORTED_BOOK_FORMATS as ReadonlyArray<string>).includes(ext);
}

function ensureSupportedBookFormat(filename: string): SupportedBookFormat {
  const ext = getExtension(filename);
  if (!ext || !isSupportedBookFormat(ext)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unsupported upload format. Supported: ${SUPPORTED_BOOK_FORMATS.map((x) => `.${x}`).join(", ")}`,
    });
  }
  return ext;
}

type ParsedBookMetadata = {
  /** Display title */
  title: string;
  /** Display author (v1: single author string) */
  author: string;
  description?: string;
  language?: string;
  published?: string;
};

type MultipartFilePart = {
  name?: string;
  filename?: string;
  type?: string;
  data?: Buffer;
};

/**
 * Skeleton metadata parsing for non-EPUB formats.
 * This intentionally does not attempt to parse real metadata yet.
 */
async function parseNonEpubMetadataFromBuffer(opts: {
  buffer: Buffer;
  format: Exclude<SupportedBookFormat, "epub">;
  filename: string;
  fallbackTitle: string;
}): Promise<ParsedBookMetadata> {
  // TODO: Implement per-format parsing later:
  // - pdf: read document info dictionary (Title/Author/Subject/Keywords)
  // - mobi/azw3: parse Kindle headers + EXTH records
  // For MVP: use safe fallbacks derived from filename.
  void opts.buffer;
  void opts.format;
  void opts.filename;

  return {
    title: opts.fallbackTitle || "Untitled",
    author: "Unknown Author",
  };
}

async function parseBookMetadataFromBuffer(opts: {
  buffer: Buffer;
  format: SupportedBookFormat;
  filename: string;
}): Promise<ParsedBookMetadata> {
  const fallbackTitle = path.basename(
    opts.filename,
    path.extname(opts.filename),
  );

  if (opts.format === "epub") {
    const meta = await parseEpubMetadataFromBuffer(opts.buffer, {
      fallbackTitle,
    });

    return {
      title: meta.title || fallbackTitle || "Untitled",
      author: meta.author || "Unknown Author",
      description: meta.description,
      language: meta.language,
      published: meta.published,
    };
  }

  return await parseNonEpubMetadataFromBuffer({
    buffer: opts.buffer,
    format: opts.format,
    filename: opts.filename,
    fallbackTitle,
  });
}

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
    sortName: makeAuthorSortKey(name),
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

/**
 * Process a single book upload (EPUB/PDF/MOBI/AZW3).
 * @param filePart
 * @param input
 * @returns object containing the book's metadata and stored file path
 */
async function processOneBookUpload(
  filePart: MultipartFilePart,
  input: { userId: string; collectionIds: string[] },
) {
  if (!filePart.filename || !filePart.data) {
    throw createError({ statusCode: 400, statusMessage: "Missing book file" });
  }

  const format = ensureSupportedBookFormat(filePart.filename);

  // Parse metadata (EPUB implemented, others skeleton)
  const meta = await parseBookMetadataFromBuffer({
    buffer: filePart.data,
    format,
    filename: filePart.filename,
  });

  const authorName = meta.author || "Unknown Author";
  const title = meta.title || "Untitled";

  const safeTitle = toSafePathSegment(title, "Untitled");

  const id = crypto.randomUUID();
  const relativePath = buildBookStorageRelativePath({
    authorNames: [authorName],
    title,
    bookId: id,
    filename: `${safeTitle}.${format}`,
    baseDir: "library",
  });

  const absolutePath = resolveDataPath(relativePath);
  const bookDirAbsolute = path.dirname(absolutePath);

  // Ensure directories exist then write file
  await mkdir(bookDirAbsolute, { recursive: true });
  await writeFile(absolutePath, filePart.data);

  // Best-effort cover extraction (EPUB only for now)
  //
  // New cover storage model:
  // - Store extracted original cover bytes as: `source.<ext>` (true original, full resolution)
  // - Store a 320px-wide thumbnail as: `thumb.webp` (used almost everywhere)
  // - Persist `books.coverImagePath` as the thumbnail path (`thumb.webp`)
  //
  // The full-res source is served only on-demand by requesting its path.
  let coverImagePath: string | null = null;
  if (format === "epub") {
    try {
      const thumbRelativePath = buildBookStorageRelativePath({
        authorNames: [authorName],
        title,
        bookId: id,
        filename: "thumb.webp",
        baseDir: "library",
      });

      const sourceRelativePath = buildBookStorageRelativePath({
        authorNames: [authorName],
        title,
        bookId: id,
        filename: "source.bin",
        baseDir: "library",
      });

      const extracted = await extractAndStoreEpubCover({
        epubFilePath: absolutePath,
        outputDirAbsolute: bookDirAbsolute,
        outputThumbRelativePathPosix: thumbRelativePath,
        outputSourceRelativePathPosix: sourceRelativePath,
        maxWidth: 320,
        webpQuality: 80,
      });

      // Store thumbnail path in DB
      coverImagePath = extracted?.thumbRelativePath ?? null;
    } catch (error) {
      logger.debug(
        error,
        "POST /api/books/upload: Failed to extract cover (continuing without cover)",
      );
      coverImagePath = null;
    }
  }

  const now = new Date();

  // Create canonical book record
  await cloudDb.insert(books).values({
    id,
    title,
    sortTitle: makeTitleSortKey(title),
    description: (meta.description || null) as string | null,
    published: (meta.published || null) as string | null,
    language: (meta.language || null) as string | null,
    coverImagePath,
    createdByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
  });

  // Attach author (lean v1: one author)
  const author = await findOrCreateAuthorByName(authorName);
  await cloudDb.insert(bookAuthors).values({
    bookId: id,
    authorId: author.id,
    position: 1,
  });

  // Attach uploaded file
  await cloudDb.insert(bookFiles).values({
    id: crypto.randomUUID(),
    bookId: id,
    format,
    relativePath,
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
    format,
    relativePath,
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
      statusMessage: "Missing book file(s)",
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
      const book = await processOneBookUpload(part, { userId, collectionIds });
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
