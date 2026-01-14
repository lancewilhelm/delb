import path from 'node:path';
import { rm } from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  bookFiles,
  books,
  collectionBooks,
  bookAuthors,
  bookTags,
  bookIdentifiers,
  userBookStatus,
  bookRatings,
  bookNotes,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

type DeleteMode = 'db_only' | 'everything';

function normalizeDeleteMode(raw: string | null | undefined): DeleteMode {
  const v = (raw ?? '').toString().trim();
  if (v === 'db_only' || v === 'everything') return v;
  return 'everything';
}

function normalizePosix(p: string): string {
  return (p ?? '')
    .toString()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function resolveUnderLibrary(
  libraryBaseAbs: string,
  storedPath: string,
): string {
  // Stored paths should be under `library/...` (POSIX-style).
  // Normalize to path relative to `<projectRoot>/library`.
  const stored = normalizePosix(storedPath);
  const relFromLibrary = stored
    .replace(/^library\//, '')
    .replace(/^library[\\/]/, '');
  const abs = path.resolve(
    libraryBaseAbs,
    relFromLibrary.split('/').join(path.sep),
  );

  const relToBase = path.relative(libraryBaseAbs, abs);
  if (relToBase.startsWith('..') || relToBase.includes(`..${path.sep}`)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' });
  }

  return abs;
}

async function safeRmFile(absPath: string, logCtx: string) {
  try {
    await rm(absPath, { force: true });
  } catch (e) {
    logger.warn(e, `${logCtx}: Failed to delete file (continuing)`);
  }
}

async function safeRmDir(absPath: string, logCtx: string) {
  try {
    await rm(absPath, { force: true, recursive: true });
  } catch (e) {
    logger.warn(e, `${logCtx}: Failed to delete directory (continuing)`);
  }
}

/**
 * Given any known absolute file path for this book under `<projectRoot>/library`,
 * compute the book directory (e.g. `<projectRoot>/library/<author>/<title (id8)>`).
 */
function getBookDirFromKnownAbsPath(
  libraryBaseAbs: string,
  absPath: string,
): string | null {
  const relToBase = path.relative(libraryBaseAbs, absPath);
  if (relToBase.startsWith('..') || relToBase.includes(`..${path.sep}`))
    return null;
  return path.dirname(absPath);
}

/**
 * DELETE /api/books/:id
 *
 * Admin-only endpoint that deletes the book. Supports only 2 modes:
 *
 * Query params:
 * - mode=
 *   - db_only:     DB rows only (no disk changes).
 *   - everything:  DB rows + delete the book folder under `library/` (default).
 */
export default defineEventHandler(async (event) => {
  logger.debug('DELETE /api/books/:id');

  // Ensure the user is authenticated and is an admin/owner
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (
    !session ||
    (session.user.role !== 'admin' && session.user.role !== 'owner')
  ) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const id = getRouterParam(event, 'id');
  if (!id) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Missing book id' };
  }

  const mode = normalizeDeleteMode(getQuery(event)?.mode?.toString());

  try {
    // Load the book first so we know what to delete from disk
    const rows = await cloudDb.select().from(books).where(eq(books.id, id));
    const book = rows[0];

    if (!book) {
      setResponseStatus(event, 404);
      return { success: false, message: 'Book not found' };
    }

    // Load associated files (formats)
    const fileRows = await cloudDb
      .select()
      .from(bookFiles)
      .where(eq(bookFiles.bookId, id));

    const libraryBaseAbs = path.resolve(process.cwd(), 'library');

    // Determine the book directory (best-effort) from any available stored path.
    // We prefer any book file path, but can fall back to coverImagePath.
    let bookDirAbs: string | null = null;

    const firstFileRel =
      fileRows.find((r) => r.relativePath)?.relativePath ?? null;
    if (firstFileRel) {
      const knownAbs = resolveUnderLibrary(libraryBaseAbs, firstFileRel);
      bookDirAbs = getBookDirFromKnownAbsPath(libraryBaseAbs, knownAbs);
    } else if (book.coverImagePath) {
      const knownAbs = resolveUnderLibrary(libraryBaseAbs, book.coverImagePath);
      bookDirAbs = getBookDirFromKnownAbsPath(libraryBaseAbs, knownAbs);
    }

    const logCtx = `DELETE /api/books/:id (${mode})`;

    // 1) Delete on-disk artifacts (best-effort)
    //
    // Only delete disk content when mode=everything.
    // `db_only` intentionally leaves the library folder untouched.
    if (mode === 'everything') {
      // Remove files we know about (best-effort)
      for (const f of fileRows) {
        if (!f.relativePath) continue;
        const fileAbs = resolveUnderLibrary(libraryBaseAbs, f.relativePath);
        await safeRmFile(fileAbs, logCtx);
      }

      if (book.coverImagePath) {
        const coverAbs = resolveUnderLibrary(
          libraryBaseAbs,
          book.coverImagePath,
        );
        await safeRmFile(coverAbs, logCtx);
      }

      // Finally remove the entire folder if we can determine it
      if (bookDirAbs) {
        await safeRmDir(bookDirAbs, logCtx);
      }
    }

    // 2) Delete associated DB rows (ordering chosen to avoid foreign key issues)
    await cloudDb.delete(collectionBooks).where(eq(collectionBooks.bookId, id));
    await cloudDb.delete(bookFiles).where(eq(bookFiles.bookId, id));
    await cloudDb.delete(bookAuthors).where(eq(bookAuthors.bookId, id));
    await cloudDb.delete(bookTags).where(eq(bookTags.bookId, id));
    await cloudDb.delete(bookIdentifiers).where(eq(bookIdentifiers.bookId, id));

    // per-user state
    await cloudDb.delete(userBookStatus).where(eq(userBookStatus.bookId, id));
    await cloudDb.delete(bookRatings).where(eq(bookRatings.bookId, id));
    await cloudDb.delete(bookNotes).where(eq(bookNotes.bookId, id));

    // 3) Delete the canonical book row
    await cloudDb.delete(books).where(eq(books.id, id));

    return { success: true, data: { mode } };
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

    logger.error(error, 'DELETE /api/books/:id: Error deleting book');
    setResponseStatus(event, 500);
    return { success: false, message: 'Internal server error' };
  }
});
