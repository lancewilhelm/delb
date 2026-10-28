import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';

import { and, eq, ne } from 'drizzle-orm';

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
  storageOperations,
} from '~/utils/db/schema';
import { withBookStorageLock } from '~~/server/utils/books/storage/book-lock';
import { deleteStoredFiles } from '~~/server/utils/books/storage/delete-operation';
import { deleteDecision } from '~~/server/utils/books/storage/delete-recovery';

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

function resolveUnderLibrary(
  libraryBaseAbs: string,
  storedPath: string,
): string {
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

function canDeleteBook(opts: {
  actor: DeleteBookActor;
  bookCreatedByUserId: string | null;
}): boolean {
  const role = (opts.actor.role ?? '').toString();
  if (role === 'admin' || role === 'owner') return true;
  if (!opts.bookCreatedByUserId) return false;
  return opts.bookCreatedByUserId === opts.actor.id;
}

async function deleteBookUnlocked(opts: {
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

  const sources: string[] = [];
  if (mode === 'everything') {
    const paths = [
      ...fileRows.map((file) => file.relativePath),
      book.coverImagePath,
    ];
    for (const stored of new Set(paths)) {
      if (!stored) continue;
      const [sharedFiles, sharedCovers] = await Promise.all([
        cloudDb
          .select({ id: bookFiles.id })
          .from(bookFiles)
          .where(
            and(
              eq(bookFiles.relativePath, stored),
              ne(bookFiles.bookId, bookId),
            ),
          )
          .limit(1),
        cloudDb
          .select({ id: books.id })
          .from(books)
          .where(and(eq(books.coverImagePath, stored), ne(books.id, bookId)))
          .limit(1),
      ]);
      if (sharedFiles.length || sharedCovers.length) continue;
      const file = resolveUnderLibrary(libraryBaseAbs, stored);
      try {
        await stat(file);
        sources.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const commit = async (operationId?: string) => {
    await cloudDb.transaction(async (tx) => {
      if (operationId)
        await tx.insert(storageOperations).values({
          id: operationId,
          bookId,
          kind: 'delete',
          createdAt: new Date(),
        });
      await tx
        .delete(collectionBooks)
        .where(eq(collectionBooks.bookId, bookId));
      await tx.delete(bookFiles).where(eq(bookFiles.bookId, bookId));
      await tx.delete(bookAuthors).where(eq(bookAuthors.bookId, bookId));
      await tx.delete(bookTags).where(eq(bookTags.bookId, bookId));
      await tx
        .delete(bookIdentifiers)
        .where(eq(bookIdentifiers.bookId, bookId));
      await tx.delete(userBookStatus).where(eq(userBookStatus.bookId, bookId));
      await tx.delete(bookRatings).where(eq(bookRatings.bookId, bookId));
      await tx.delete(bookNotes).where(eq(bookNotes.bookId, bookId));
      await tx.delete(books).where(eq(books.id, bookId));
    });
  };
  if (mode === 'everything') {
    await mkdir(libraryBaseAbs, { recursive: true });
    await deleteStoredFiles({
      root: libraryBaseAbs,
      bookId,
      sources,
      decision: deleteDecision,
      commit,
    });
  } else {
    await commit();
  }
  void logCtx;

  return { mode };
}

export async function deleteBook(
  opts: Parameters<typeof deleteBookUnlocked>[0],
) {
  return await withBookStorageLock(
    path.resolve(process.cwd(), 'library'),
    opts.bookId,
    async () => await deleteBookUnlocked(opts),
  );
}
