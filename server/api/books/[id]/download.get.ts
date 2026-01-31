import path from 'node:path';
import { createReadStream } from 'node:fs';

import { and, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  bookFiles,
  books,
  collectionBooks,
  collectionMembers,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/books/:id/download
 *
 * Authenticated endpoint that streams the stored book file.
 *
 * Notes:
 * - Uses the book's `relativePath` (stored like `library/.../*.<ext>`) and resolves
 *   it safely under `<projectRoot>/library`.
 * - Includes path traversal protection.
 * - Sends Content-Disposition: attachment for download.
 * - v1 supported formats: epub, pdf, mobi, azw3
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books/:id/download');

  // Require auth (consistent with other book endpoints)
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;

  const id = getRouterParam(event, 'id');
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  }

  const query = getQuery(event);
  const requestedFileId =
    typeof query.fileId === 'string' && query.fileId.trim()
      ? query.fileId.trim()
      : null;
  const requestedFormat =
    typeof query.format === 'string' && query.format.trim()
      ? query.format.trim().toLowerCase()
      : null;

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
    throw createError({ statusCode: 404, statusMessage: 'Book not found' });
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
    throw createError({ statusCode: 404, statusMessage: 'Book not found' });
  }

  const supportedFormats = ['epub', 'pdf', 'mobi', 'azw3'] as const;

  const contentTypeByFormat: Record<(typeof supportedFormats)[number], string> =
    {
      epub: 'application/epub+zip',
      pdf: 'application/pdf',
      mobi: 'application/x-mobipocket-ebook',
      azw3: 'application/vnd.amazon.ebook',
    };

  // Choose a downloadable file (prefer best-known reading formats first)
  const preferredOrder = ['epub', 'pdf', 'azw3', 'mobi'] as const;

  const allFiles = await cloudDb
    .select()
    .from(bookFiles)
    .where(eq(bookFiles.bookId, id));

  const normalized = allFiles
    .map((f) => ({
      ...f,
      format: (f.format ?? '').toString().trim().toLowerCase(),
    }))
    .filter((f) => supportedFormats.includes(f.format as never));

  const fileFromId = requestedFileId
    ? normalized.find((f) => f.id === requestedFileId)
    : null;

  if (requestedFileId && !fileFromId) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Book file not found',
    });
  }

  const fileFromFormat = requestedFormat
    ? normalized.find((f) => f.format === requestedFormat)
    : null;

  if (requestedFormat && !fileFromFormat) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Book file not found',
    });
  }

  const file =
    fileFromId ??
    fileFromFormat ??
    preferredOrder
      .map((fmt) => normalized.find((f) => f.format === fmt))
      .find(Boolean) ??
    normalized[0];

  if (!file?.relativePath) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Book file path missing',
    });
  }

  // Resolve the stored file path safely under <projectRoot>/library
  // Stored `relativePath` is like: library/<author>/<title (id8)>/<filename>
  const libraryBaseAbs = path.resolve(process.cwd(), 'library');
  const relFromLibrary = file.relativePath.replace(/^library[\\/]/, '');
  const fileAbs = path.resolve(libraryBaseAbs, relFromLibrary);

  // Path traversal protection: must remain under libraryBaseAbs
  const relToBase = path.relative(libraryBaseAbs, fileAbs);
  if (relToBase.startsWith('..') || relToBase.includes(`..${path.sep}`)) {
    logger.warn(
      { id, relativePath: file.relativePath },
      'GET /api/books/:id/download: blocked path traversal attempt',
    );
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' });
  }

  const format = (file.format || path.extname(fileAbs).slice(1))
    .trim()
    .toLowerCase();

  if (!supportedFormats.includes(format as never)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Unsupported book format for download',
    });
  }

  // Provide a friendly filename
  const safe = (s: string) =>
    s
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim();

  const filename = `${safe(book.title)}.${format}`;

  setHeader(event, 'Content-Type', contentTypeByFormat[format as never]);
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`);
  // For privacy, avoid caching by intermediaries.
  setHeader(event, 'Cache-Control', 'private, no-store');

  try {
    return sendStream(event, createReadStream(fileAbs));
  } catch (error: unknown) {
    logger.error(error, 'GET /api/books/:id/download: failed to stream file');
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }
});
