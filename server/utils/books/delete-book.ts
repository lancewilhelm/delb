import path from 'node:path';
import { rm } from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  bookAuthors,
  bookFiles,
  bookIdentifiers,
  bookNotes,
  bookRatings,
  bookTags,
  books,
  collectionBooks,
  userBookStatus,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';

export type DeleteMode = 'db_only' | 'everything';

export type DeleteBookActor = {
  id: string;
  role?: string | null;
};

function normalizePosix(p: string): string {
  return (p ?? '')
    .toString()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function resolveUnderLibrary(libraryBaseAbs: string, storedPath: string): string {
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

function getBookDirFromKnownAbsPath(
  libraryBaseAbs: string,
  absPath: string,
): string | null {
  const relToBase = path.relative(libraryBaseAbs, absPath);
  if (relToBase.startsWith('..') || relToBase.includes(`..${path.sep}`))
    return null;
  return path.dirname(absPath);
}

function canDeleteBook(opts: {
  actor: DeleteBookActor;
  bookCreatedByUserId: string | null;
}): boolean {
  const role = (opts.actor.role ?? '').toString();
  if (role === 'admin' || role === 'owner') return true;
  if (!opts.bookCreatedByUserId) return false;
  return opts.bookCreatedByUserId === opts.actor.id;
}

export async function deleteBook(opts: {
  bookId: string;
  mode: DeleteMode;
  actor: DeleteBookActor;
  logCtx: string;
}) {
  const { bookId, mode, actor, logCtx } = opts;

  const rows = await cloudDb.select().from(books).where(eq(books.id, bookId));
  const book = rows[0];

  if (!book) {
    throw createError({ statusCode: 404, statusMessage: 'Book not found' });
  }

  if (!canDeleteBook({ actor, bookCreatedByUserId: book.createdByUserId })) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }

  const fileRows = await cloudDb
    .select()
    .from(bookFiles)
    .where(eq(bookFiles.bookId, bookId));

  const libraryBaseAbs = path.resolve(process.cwd(), 'library');

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

  if (mode === 'everything') {
    for (const f of fileRows) {
      if (!f.relativePath) continue;
      const fileAbs = resolveUnderLibrary(libraryBaseAbs, f.relativePath);
      await safeRmFile(fileAbs, logCtx);
    }

    if (book.coverImagePath) {
      const coverAbs = resolveUnderLibrary(libraryBaseAbs, book.coverImagePath);
      await safeRmFile(coverAbs, logCtx);
    }

    if (bookDirAbs) {
      await safeRmDir(bookDirAbs, logCtx);
    }
  }

  await cloudDb.delete(collectionBooks).where(eq(collectionBooks.bookId, bookId));
  await cloudDb.delete(bookFiles).where(eq(bookFiles.bookId, bookId));
  await cloudDb.delete(bookAuthors).where(eq(bookAuthors.bookId, bookId));
  await cloudDb.delete(bookTags).where(eq(bookTags.bookId, bookId));
  await cloudDb.delete(bookIdentifiers).where(eq(bookIdentifiers.bookId, bookId));
  await cloudDb.delete(userBookStatus).where(eq(userBookStatus.bookId, bookId));
  await cloudDb.delete(bookRatings).where(eq(bookRatings.bookId, bookId));
  await cloudDb.delete(bookNotes).where(eq(bookNotes.bookId, bookId));
  await cloudDb.delete(books).where(eq(books.id, bookId));

  return { mode };
}

