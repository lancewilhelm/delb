import path from 'node:path';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';

import { EpubError, inspectCover, setCover } from '@delb/epub';
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';

import { cloudDb } from '~~/server/utils/db/cloud';
import { resolveDataPath } from '~~/server/utils/books/fs';
import { getCanonicalBookPaths } from '~~/server/utils/books/storage/paths';
import {
  commitCoverUpdate,
  CoverUpdateStorageError,
  recoverPendingCoverUpdates,
  type CoverUpdateFile,
} from '~~/server/utils/books/cover-update-transaction';
import {
  authors,
  bookAuthors,
  bookFiles,
  books,
  collectionBooks,
  collectionMembers,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * POST /api/books/:id/cover
 *
 * Endpoint that accepts an uploaded image and stores:
 * - Original bytes as: `<book directory>/cover.<ext>` (true original)
 * - Thumbnail as:     `<book directory>/thumb.webp` (320px wide)
 *
 * Then updates `books.coverImagePath` to point at the thumbnail (`thumb.webp`).
 *
 * Notes:
 * - The UI should use `books.coverImagePath` for most places (thumbnail).
 * - The full-resolution source is available on request via
 *   `/api/books/:id/cover?variant=source`.
 *
 * Request: multipart/form-data with a single file field named `file`.
 *
 * Security:
 * - Requires authenticated session.
 * - Only system admin/owner or the book creator (books.createdByUserId) may update the cover.
 * - Ensures the requesting user can "see" the book via collection membership
 *   (same visibility model as GET /api/books/:id).
 * - Resolves and writes the cover next to the stored book file inside `library/`.
 * - Blocks path traversal by ensuring writes stay within `<projectRoot>/library`.
 *
 * Notes:
 * - If the book has stored files (`book_files`), covers are stored alongside those files.
 * - If the book has no files yet, covers are stored in the canonical directory derived from
 *   current metadata (author(s)+title+id slice), so metadata-only books can still have covers.
 * - Overwrite semantics for both files:
 *   - exactly one source file remains (`cover.<ext>`)
 *   - `thumb.webp` is overwritten
 */
export default defineEventHandler(async (event) => {
  logger.debug('POST /api/books/:id/cover');

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;
  const canEditAny =
    session.user.role === 'admin' || session.user.role === 'owner';

  const id = getRouterParam(event, 'id');
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  }

  // Parse multipart form
  const form = await readMultipartFormData(event);
  if (!form?.length) {
    throw createError({ statusCode: 400, statusMessage: 'Missing form data' });
  }

  const filePart = form.find((p) => p.name === 'file' && p.data) as
    | {
        name?: string;
        filename?: string;
        type?: string;
        data?: Buffer;
      }
    | undefined;

  if (!filePart?.data) {
    throw createError({ statusCode: 400, statusMessage: 'Missing cover file' });
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

    const canEditOwn = Boolean(
      book.createdByUserId && book.createdByUserId === userId,
    );
    if (!canEditAny && !canEditOwn) {
      throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
    }

    const libraryBaseAbs = path.resolve(process.cwd(), 'library');

    // Determine the target directory for the cover:
    // - Prefer an existing book file dir (keeps parity with previous behavior)
    // - Else fall back to existing cover dir (e.g. imported without formats)
    // - Else use the canonical folder derived from book metadata (metadata-only books)
    const files = await cloudDb
      .select()
      .from(bookFiles)
      .where(eq(bookFiles.bookId, id));

    const ensureUnderLibraryOrThrow = (
      candidateAbs: string,
      logCtx: Record<string, unknown>,
    ) => {
      const relToBase = path.relative(libraryBaseAbs, candidateAbs);
      if (relToBase.startsWith('..') || relToBase.includes(`..${path.sep}`)) {
        logger.warn(
          { id, ...logCtx },
          'POST /api/books/:id/cover: blocked path traversal attempt',
        );
        throw createError({ statusCode: 400, statusMessage: 'Invalid path' });
      }
    };

    let bookDirAbs: string | null = null;

    if (files.length) {
      const preferred =
        files.find((f) => (f.format || '').toLowerCase() === 'epub') ??
        files[0];

      if (!preferred?.relativePath) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Book file path missing; cannot store cover',
        });
      }

      // relativePath is stored like: "library/<author(s)>/<title (id8)>/<file>"
      const relFromLibrary = preferred.relativePath.replace(
        /^library[\\/]/,
        '',
      );
      const bookFileAbs = path.resolve(libraryBaseAbs, relFromLibrary);
      ensureUnderLibraryOrThrow(bookFileAbs, {
        relativePath: preferred.relativePath,
        from: 'book_files',
      });
      bookDirAbs = path.dirname(bookFileAbs);
    } else {
      const coverImagePathRaw = (book.coverImagePath ?? '').toString().trim();

      if (coverImagePathRaw) {
        const relFromLibrary = coverImagePathRaw.replace(/^library[\\/]/, '');
        const coverAbs = path.resolve(libraryBaseAbs, relFromLibrary);
        ensureUnderLibraryOrThrow(coverAbs, {
          coverImagePath: coverImagePathRaw,
          from: 'books.coverImagePath',
        });
        bookDirAbs = path.dirname(coverAbs);
      } else {
        const authorLinks = await cloudDb
          .select({
            name: authors.name,
            position: bookAuthors.position,
          })
          .from(bookAuthors)
          .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
          .where(eq(bookAuthors.bookId, id));

        const orderedAuthorNames = authorLinks
          .slice()
          .sort((a, b) => {
            const aPos = typeof a.position === 'number' ? a.position : 10_000;
            const bPos = typeof b.position === 'number' ? b.position : 10_000;
            if (aPos !== bPos) return aPos - bPos;
            return (a.name ?? '').localeCompare(b.name ?? '');
          })
          .map((a) => a.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0);

        const canonical = getCanonicalBookPaths({
          authorNames: orderedAuthorNames,
          title: book.title ?? '',
          bookId: id,
        });

        const dirAbs = resolveDataPath(canonical.bookDir);
        ensureUnderLibraryOrThrow(dirAbs, {
          canonicalBookDir: canonical.bookDir,
          from: 'canonical',
        });
        bookDirAbs = dirAbs;
      }
    }

    if (!bookDirAbs) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Failed to determine storage directory for cover',
      });
    }

    await mkdir(bookDirAbs, { recursive: true });
    const storageFallbackPaths = new Set<string>();
    const recoveryResult = await recoverPendingCoverUpdates({
      operationParent: bookDirAbs,
      allowedRoot: libraryBaseAbs,
      currentCoverImagePath: book.coverImagePath,
    });
    for (const fallbackPath of recoveryResult.backupFallbackPaths) {
      storageFallbackPaths.add(fallbackPath);
    }

    if (filePart.data.length > 25 * 1024 * 1024) {
      throw createError({
        statusCode: 413,
        statusMessage: 'Cover image exceeds the 25 MiB upload limit',
      });
    }

    // Detect the uploaded image format so we can persist the true original as `cover.<ext>`.
    let meta: sharp.Metadata;
    try {
      meta = await sharp(filePart.data).rotate().metadata();
    } catch {
      throw createError({
        statusCode: 415,
        statusMessage: 'Unsupported or invalid cover image',
      });
    }
    const fmt = (meta.format || '').toString().toLowerCase();
    if (meta.width && meta.height && meta.width * meta.height > 100_000_000) {
      throw createError({
        statusCode: 413,
        statusMessage: 'Cover image exceeds the 100 megapixel limit',
      });
    }

    const ext: string | null =
      fmt === 'jpeg' || fmt === 'jpg'
        ? 'jpg'
        : fmt === 'png'
          ? 'png'
          : fmt === 'webp'
            ? 'webp'
            : fmt === 'gif'
              ? 'gif'
              : fmt === 'avif'
                ? 'avif'
                : fmt === 'tiff'
                  ? 'tiff'
                  : null;
    if (!ext) {
      throw createError({
        statusCode: 415,
        statusMessage: 'Unsupported cover image format',
      });
    }

    const sourceAbs = path.join(bookDirAbs, `cover.${ext}`);
    const thumbAbs = path.join(bookDirAbs, 'thumb.webp');
    const sourceNamePattern =
      /^(cover|source)(\.(source))?\.(jpg|jpeg|png|webp|gif|avif|tif|tiff)$/i;
    const targetSourceName = path.basename(sourceAbs).toLowerCase();

    const [thumbWebp, embeddedJpeg] = await Promise.all([
      sharp(filePart.data)
        .rotate()
        .resize({ width: 320, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer(),
      sharp(filePart.data).rotate().jpeg({ quality: 95 }).toBuffer(),
    ]);

    // DB should point to the thumbnail by default (most views use this).
    const thumbRelPosix = path.posix.join(
      'library',
      ...path.relative(libraryBaseAbs, thumbAbs).split(path.sep),
    );

    const updates: CoverUpdateFile[] = [
      { targetPath: sourceAbs, data: filePart.data },
      { targetPath: thumbAbs, data: thumbWebp },
    ];
    const epubWarnings: string[] = [];
    const epubFiles = files.filter(
      (file) => (file.format ?? '').toLowerCase() === 'epub',
    );
    for (const epubFile of epubFiles) {
      const relFromLibrary = epubFile.relativePath.replace(/^library[\\/]/, '');
      const epubAbs = path.resolve(libraryBaseAbs, relFromLibrary);
      ensureUnderLibraryOrThrow(epubAbs, {
        relativePath: epubFile.relativePath,
        from: 'book_files_epub',
      });
      const result = await setCover(await readFile(epubAbs), {
        data: embeddedJpeg,
        mediaType: 'image/jpeg',
      });
      const verified = await inspectCover(result.data);
      if (!verified || verified.mediaType !== 'image/jpeg') {
        throw new EpubError(
          'INVALID_EPUB',
          `Rewritten EPUB did not contain the expected JPEG cover: ${epubFile.relativePath}`,
        );
      }
      epubWarnings.push(
        ...result.warnings.map(
          (warning) => `${epubFile.relativePath}: ${warning}`,
        ),
      );
      updates.push({ targetPath: epubAbs, data: result.data });
    }

    const commitResult = await commitCoverUpdate({
      operationParent: bookDirAbs,
      allowedRoot: libraryBaseAbs,
      previousCoverImagePath: book.coverImagePath,
      expectedCoverImagePath: thumbRelPosix,
      files: updates,
      commitDatabase: async () => {
        await cloudDb.transaction(async (tx) => {
          await tx
            .update(books)
            .set({ coverImagePath: thumbRelPosix, updatedAt: new Date() })
            .where(eq(books.id, id));
        });
      },
      rollbackDatabase: async () => {
        await cloudDb
          .update(books)
          .set({ coverImagePath: book.coverImagePath, updatedAt: new Date() })
          .where(eq(books.id, id));
      },
    });
    for (const fallbackPath of commitResult.backupFallbackPaths) {
      storageFallbackPaths.add(fallbackPath);
    }
    if (storageFallbackPaths.size > 0) {
      logger.warn(
        {
          id,
          files: [...storageFallbackPaths].map((fallbackPath) =>
            path.relative(libraryBaseAbs, fallbackPath),
          ),
        },
        'POST /api/books/:id/cover: used verified-copy fallback for library storage',
      );
    }

    // Old source variants are no longer referenced. This cleanup is deliberately
    // after the transactional swap so it cannot compromise rollback.
    try {
      const entries = await readdir(bookDirAbs, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !sourceNamePattern.test(entry.name)) continue;
        if (entry.name.toLowerCase() === targetSourceName) continue;
        await unlink(path.join(bookDirAbs, entry.name));
      }
    } catch (cleanupError) {
      logger.warn(
        { id, cleanupError },
        'POST /api/books/:id/cover: failed to fully clean prior source variants',
      );
    }

    return {
      success: true,
      data: {
        coverImagePath: thumbRelPosix,
        embeddedEpubs: epubFiles.length,
        totalEpubs: epubFiles.length,
        storageFallbacks: storageFallbackPaths.size,
        warnings: epubWarnings,
      },
    };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    if (error instanceof CoverUpdateStorageError) {
      logger.error(
        { err: error, id, code: error.code },
        'POST /api/books/:id/cover: library storage could not safely replace an existing file',
      );
      throw createError({
        statusCode: 507,
        statusMessage:
          'Library storage could not safely replace an existing cover file',
        data: { code: error.code },
      });
    }

    if (error instanceof EpubError) {
      logger.warn(
        { err: error, id, code: error.code },
        'POST /api/books/:id/cover: EPUB cover update rejected',
      );
      throw createError({
        statusCode: 422,
        statusMessage: `EPUB cover update failed: ${error.message}`,
        data: { code: error.code },
      });
    }

    logger.error(error, 'POST /api/books/:id/cover: failed to upload cover');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to upload cover',
    });
  }
});
