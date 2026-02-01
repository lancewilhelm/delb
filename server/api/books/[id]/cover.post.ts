import path from 'node:path';
import { stat, writeFile } from 'node:fs/promises';

import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';

import { cloudDb } from '~~/server/utils/db/cloud';
import { CalibreReader } from '~~/server/utils/import/calibre/calibre-reader';
import {
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
 * - The full-resolution source is available on request via `/api/media/covers/.../cover.<ext>`.
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
 *   - `cover.<ext>` is overwritten
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
  const canEditAny = session.user.role === 'admin' || session.user.role === 'owner';

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

    const canEditOwn = Boolean(book.createdByUserId && book.createdByUserId === userId);
    if (!canEditAny && !canEditOwn) {
      throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
    }

    const libraryBaseAbs = path.resolve(process.cwd(), 'library');

    // Determine the target directory for the cover:
    // - Prefer an existing book file dir (keeps parity with previous behavior)
    // - Else use Calibre's book folder when available
    // - Else fall back to existing cover dir
    // Note: we do NOT create new folders when updating an existing book.
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

    const ensureExistingDirOrThrow = async (
      candidateAbs: string,
      logCtx: Record<string, unknown>,
    ) => {
      try {
        const st = await stat(candidateAbs);
        if (!st.isDirectory()) throw new Error('not a directory');
      } catch (error) {
        logger.warn(
          { err: error, id, ...logCtx },
          'POST /api/books/:id/cover: book directory missing on disk',
        );
        throw createError({
          statusCode: 409,
          statusMessage:
            'Book directory missing on disk; re-scan Calibre or restore the library folder.',
        });
      }
    };

    const resolveCalibreBookDirAbs = async (
      calibreBookId: number,
    ): Promise<string | null> => {
      let reader: CalibreReader | null = null;
      try {
        reader = new CalibreReader({
          libraryRootAbs: libraryBaseAbs,
          readonly: true,
        });

        const calibreBook = await reader.getBookById(calibreBookId);
        const relDir = (calibreBook?.path ?? '').toString().trim();
        if (!relDir) return null;

        const dirAbs = path.resolve(libraryBaseAbs, relDir);
        ensureUnderLibraryOrThrow(dirAbs, {
          calibreBookId,
          from: 'calibre',
        });
        return dirAbs;
      } catch (error) {
        logger.warn(
          error,
          'POST /api/books/:id/cover: failed to resolve Calibre book path',
        );
        return null;
      } finally {
        if (reader) await reader.close();
      }
    };

    let bookDirAbs: string | null = null;
    let bookDirSource: string | null = null;

    if (files.length) {
      const preferred =
        files.find((f) => (f.format || '').toLowerCase() === 'epub') ?? files[0];

      if (!preferred?.relativePath) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Book file path missing; cannot store cover',
        });
      }

      // relativePath is stored like: "library/<author(s)>/<title (id8)>/<file>"
      const relFromLibrary = preferred.relativePath.replace(/^library[\\/]/, '');
      const bookFileAbs = path.resolve(libraryBaseAbs, relFromLibrary);
      ensureUnderLibraryOrThrow(bookFileAbs, {
        relativePath: preferred.relativePath,
        from: 'book_files',
      });
      bookDirAbs = path.dirname(bookFileAbs);
      bookDirSource = 'book_files';
    } else {
      const calibreBookId =
        typeof book.calibreBookId === 'number' &&
        Number.isFinite(book.calibreBookId)
          ? book.calibreBookId
          : null;

      if (calibreBookId) {
        const calibreDirAbs = await resolveCalibreBookDirAbs(calibreBookId);
        if (calibreDirAbs) {
          await ensureExistingDirOrThrow(calibreDirAbs, { calibreBookId });
          bookDirAbs = calibreDirAbs;
          bookDirSource = 'calibre';
        } else {
          throw createError({
            statusCode: 409,
            statusMessage:
              'Calibre book path unavailable; re-scan Calibre before updating covers.',
          });
        }
      }

      if (!bookDirAbs) {
        const coverImagePathRaw = (book.coverImagePath ?? '').toString().trim();

        if (coverImagePathRaw) {
          const relFromLibrary = coverImagePathRaw.replace(/^library[\\/]/, '');
          const coverAbs = path.resolve(libraryBaseAbs, relFromLibrary);
          ensureUnderLibraryOrThrow(coverAbs, {
            coverImagePath: coverImagePathRaw,
            from: 'books.coverImagePath',
          });
          bookDirAbs = path.dirname(coverAbs);
          bookDirSource = 'books.coverImagePath';
        }
      }
    }

    if (!bookDirAbs) {
      throw createError({
        statusCode: 409,
        statusMessage:
          'Book storage directory not found; re-scan/import or upload a book file first.',
      });
    }

    await ensureExistingDirOrThrow(bookDirAbs, {
      from: bookDirSource ?? 'resolved',
    });

    // Detect the uploaded image format so we can persist the true original as `cover.<ext>`.
    const meta = await sharp(filePart.data).rotate().metadata();
    const fmt = (meta.format || '').toString().toLowerCase();

    // Map sharp's format names to common file extensions.
    // If we can't confidently detect, fall back to jpg (still preserves original pixels, but re-encodes).
    const ext =
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
                  : 'jpg';

    const sourceAbs = path.join(bookDirAbs, `cover.${ext}`);
    const thumbAbs = path.join(bookDirAbs, 'thumb.webp');

    // Thumbnail: 320px wide, webp for consistent lightweight UI rendering.
    const thumbWebp = await sharp(filePart.data)
      .rotate() // respect EXIF orientation
      .resize({
        width: 320,
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();

    if (ext === 'jpg') {
      // If we had to fall back (unknown format), store a high-quality JPEG as the "source".
      // This is the best we can do without a trustworthy original container format.
      const sourceJpeg = await sharp(filePart.data)
        .rotate()
        .jpeg({ quality: 95 })
        .toBuffer();
      await writeFile(sourceAbs, sourceJpeg);
    } else {
      // Store exact uploaded bytes as source.
      await writeFile(sourceAbs, filePart.data);
    }

    await writeFile(thumbAbs, thumbWebp);

    // DB should point to the thumbnail by default (most views use this).
    const thumbRelPosix = path.posix.join(
      'library',
      ...path.relative(libraryBaseAbs, thumbAbs).split(path.sep),
    );

    await cloudDb
      .update(books)
      .set({ coverImagePath: thumbRelPosix, updatedAt: new Date() })
      .where(eq(books.id, id));

    return {
      success: true,
      data: {
        coverImagePath: thumbRelPosix,
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

    logger.error(error, 'POST /api/books/:id/cover: failed to upload cover');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to upload cover',
    });
  }
});
