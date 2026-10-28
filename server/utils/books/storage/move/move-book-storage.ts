import path from 'node:path';
import { stat, readdir, rmdir } from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  bookFiles,
  books,
  storageOperations,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { moveStoredFiles } from '~~/server/utils/books/storage/move-operation';
import { moveDecision } from '~~/server/utils/books/storage/move-recovery';
import {
  BOOK_STORAGE_DEFAULTS,
  buildBookStorageRelativePath,
  getCanonicalBookPaths,
  osToPosixPath,
  posixToOsPath,
} from '~~/server/utils/books/storage/paths';

/**
 * Move a book's on-disk storage to match the canonical folder structure derived from
 * the book's current title + ordered authors.
 *
 * This helper:
 * - Computes the canonical destination directory for the book (library/<authors>/<title (id8)>).
 * - Moves all known book files (book_files) into the destination directory.
 * - Moves cover.webp if present (books.coverImagePath) into the destination directory.
 * - Updates DB fields:
 *   - book_files.relativePath for every file moved
 *   - books.coverImagePath if moved
 *
 * Safety / constraints:
 * - Path traversal protection: all resolved paths must remain under <projectRoot>/library.
 * - Idempotent-ish: if current and target path already match, it will skip work.
 * - Collision handling: target dir includes a short id slice so collisions are unlikely; if a destination file exists,
 *   we fail fast rather than overwrite.
 *
 * Notes:
 * - This does not attempt to create or remove symlinks.
 * - This does not currently garbage collect empty parent dirs, except trying to remove the old dir
 *   when it's empty (best-effort).
 */

export type MoveBookStorageResult = {
  moved: boolean;
  reason?:
    'no-files' | 'already-canonical' | 'moved' | 'skipped-missing-on-disk';
  fromDir?: string;
  toDir?: string;
  updatedFileCount?: number;
  movedCover?: boolean;
};

function resolveUnderLibraryOrThrow(storedPosixPath: string): {
  libraryBaseAbs: string;
  abs: string;
  relFromLibraryPosix: string;
} {
  const libraryBaseAbs = path.resolve(
    process.cwd(),
    BOOK_STORAGE_DEFAULTS.baseDir,
  );

  // Normalize to "relative to library/..." and then resolve against the base.
  const relFromLibraryPosix = (storedPosixPath ?? '')
    .toString()
    .replace(/^library[\\/]/, ''); // accept either separator in stored string

  const abs = path.resolve(libraryBaseAbs, posixToOsPath(relFromLibraryPosix));

  const relToBase = path.relative(libraryBaseAbs, abs);
  if (relToBase.startsWith('..') || relToBase.includes(`..${path.sep}`)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' });
  }

  return {
    libraryBaseAbs,
    abs,
    relFromLibraryPosix: osToPosixPath(relFromLibraryPosix),
  };
}

function dirnamePosix(posixPath: string): string {
  const parts = (posixPath ?? '').split('/').filter((p) => p.length > 0);
  if (parts.length <= 1) return parts[0] ?? '';
  return parts.slice(0, -1).join('/');
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function moveBookStorageToCanonical(opts: {
  bookId: string;
}): Promise<MoveBookStorageResult> {
  const { bookId } = opts;

  // Load the book and its author display names (ordered).
  const bookRows = await cloudDb
    .select()
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  const book = bookRows[0];
  if (!book) {
    throw createError({ statusCode: 404, statusMessage: 'Book not found' });
  }

  const authorLinks = await cloudDb
    .select({
      authorId: bookAuthors.authorId,
      position: bookAuthors.position,
      name: authors.name,
    })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(eq(bookAuthors.bookId, bookId));

  const ordered = authorLinks
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
    authorNames: ordered,
    title: book.title ?? '',
    bookId,
  });

  // Load files. If there are no files, fall back to cover path when present.
  const files = await cloudDb
    .select()
    .from(bookFiles)
    .where(eq(bookFiles.bookId, bookId));

  let currentDirPosix = '';
  if (files.length) {
    // Determine "current directory" by looking at a preferred file.
    const preferred =
      files.find((f) => (f.format ?? '').toLowerCase() === 'epub') ?? files[0];

    const currentRel = preferred?.relativePath;
    if (currentRel) {
      currentDirPosix = dirnamePosix(currentRel);
    }
  } else if (book.coverImagePath) {
    currentDirPosix = dirnamePosix(book.coverImagePath);
  }

  if (!currentDirPosix) {
    return { moved: false, reason: 'no-files' };
  }
  const targetDirPosix = canonical.bookDir;

  if (normalizePosix(currentDirPosix) === normalizePosix(targetDirPosix)) {
    // Still ensure cover path matches (cheap). If it doesn't, we can update/move cover later,
    // but for now treat as already canonical.
    await cleanupEmptyLibraryDirs();
    return {
      moved: false,
      reason: 'already-canonical',
      fromDir: currentDirPosix,
      toDir: targetDirPosix,
    };
  }

  const { libraryBaseAbs } = resolveUnderLibraryOrThrow(
    `${BOOK_STORAGE_DEFAULTS.baseDir}/dummy`,
  );
  const targetDirAbs = resolveUnderLibraryOrThrow(targetDirPosix).abs;
  const currentDirAbs = resolveUnderLibraryOrThrow(currentDirPosix).abs;
  const entries: Array<{ source: string; destination: string }> = [];
  const updates: Array<{ id: string; relativePath: string }> = [];
  const knownSources = new Set<string>();
  for (const file of files) {
    if (!file.relativePath) continue;
    const source = resolveUnderLibraryOrThrow(file.relativePath).abs;
    knownSources.add(source);
    const format = (file.format ?? '').trim().toLowerCase();
    const relativePath = format
      ? buildBookStorageRelativePath({
          authorNames: ordered,
          title: book.title ?? '',
          bookId,
          filename: `${book.title ?? 'Untitled'}.${format}`,
          baseDir: 'library',
        })
      : file.relativePath;
    const destination = resolveUnderLibraryOrThrow(relativePath).abs;
    if (source === destination) continue;
    if (!(await fileExists(source))) {
      logger.warn(
        { bookId, relativePath: file.relativePath },
        'Canonical move source is missing',
      );
      throw new Error(`Canonical move source is missing: ${file.relativePath}`);
    }
    entries.push({ source, destination });
    updates.push({ id: file.id, relativePath });
  }
  let coverPath: string | null = null;
  if (book.coverImagePath) {
    const source = resolveUnderLibraryOrThrow(book.coverImagePath).abs;
    knownSources.add(source);
    const destination = path.join(targetDirAbs, path.basename(source));
    if (source !== destination) {
      if (!(await fileExists(source)))
        throw new Error(`Canonical cover is missing: ${book.coverImagePath}`);
      entries.push({ source, destination });
      coverPath = [
        BOOK_STORAGE_DEFAULTS.baseDir,
        ...path.relative(libraryBaseAbs, destination).split(path.sep),
      ].join('/');
    }
  }
  let sidecars: import('node:fs').Dirent[];
  try {
    sidecars = await readdir(currentDirAbs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    sidecars = [];
  }
  for (const entry of sidecars) {
    const source = path.join(currentDirAbs, entry.name);
    if (knownSources.has(source)) continue;
    if (!entry.isFile())
      throw new Error(`Cannot safely move sidecar: ${source}`);
    entries.push({ source, destination: path.join(targetDirAbs, entry.name) });
  }
  if (!entries.length) return { moved: false, reason: 'no-files' };
  await moveStoredFiles({
    root: libraryBaseAbs,
    bookId,
    entries,
    decision: moveDecision,
    commit: async (id) => {
      await cloudDb.transaction(async (tx) => {
        await tx
          .insert(storageOperations)
          .values({ id, bookId, kind: 'move', createdAt: new Date() });
        for (const update of updates)
          await tx
            .update(bookFiles)
            .set({ relativePath: update.relativePath })
            .where(eq(bookFiles.id, update.id));
        if (coverPath)
          await tx
            .update(books)
            .set({ coverImagePath: coverPath, updatedAt: new Date() })
            .where(eq(books.id, bookId));
      });
    },
  });
  try {
    await rmdir(currentDirAbs);
  } catch {
    /* Directory still contains user data. */
  }
  await cleanupEmptyParents(path.dirname(currentDirAbs), libraryBaseAbs);
  return {
    moved: true,
    reason: 'moved',
    fromDir: currentDirPosix,
    toDir: targetDirPosix,
    updatedFileCount: updates.length,
    movedCover: Boolean(coverPath),
  };
}

function normalizePosix(p: string): string {
  return (p ?? '')
    .toString()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

async function removeDirIfOnlyIgnorable(dirAbs: string): Promise<boolean> {
  try {
    await rmdir(dirAbs);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function cleanupEmptyParents(startDirAbs: string, stopAtAbs: string) {
  let current = startDirAbs;
  const stop = path.resolve(stopAtAbs);

  while (current && path.resolve(current) !== stop) {
    const removed = await removeDirIfOnlyIgnorable(current);
    if (!removed) break;
    current = path.dirname(current);
  }
}

async function cleanupEmptyLibraryDirs() {
  try {
    const { libraryBaseAbs } = resolveUnderLibraryOrThrow(
      `${BOOK_STORAGE_DEFAULTS.baseDir}/dummy`,
    );
    const authorDirs = await readdir(libraryBaseAbs, { withFileTypes: true });
    for (const entry of authorDirs) {
      if (!entry.isDirectory()) continue;
      const authorDirAbs = path.join(libraryBaseAbs, entry.name);
      const removed = await removeDirIfOnlyIgnorable(authorDirAbs);
      void removed;
    }
  } catch {
    // ignore
  }
}
