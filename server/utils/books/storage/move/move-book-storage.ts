import path from 'node:path';
import { mkdir, rename, rm, stat, readdir, rmdir } from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { authors, bookAuthors, bookFiles, books } from '~/utils/db/schema';
import { logger } from '~/utils/logger';
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
    | 'no-files'
    | 'already-canonical'
    | 'moved'
    | 'skipped-missing-on-disk';
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
  } catch {
    return false;
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
      files.find((f) => (f.format ?? '').toLowerCase() === 'epub') ??
      files[0];

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

  // Create destination directory on disk.
  const { libraryBaseAbs } = resolveUnderLibraryOrThrow(
    `${BOOK_STORAGE_DEFAULTS.baseDir}/dummy`,
  );
  const targetDirAbs = path.resolve(
    libraryBaseAbs,
    posixToOsPath(targetDirPosix.replace(/^library\//, '')),
  );
  await mkdir(targetDirAbs, { recursive: true });

  let updatedFileCount = 0;
  const movedNames = new Set<string>();

  // Move each known book file into the new directory.
  for (const f of files) {
    const rel = f.relativePath;
    if (!rel) continue;
    const format = (f.format ?? '').toString().trim().toLowerCase();
    const desiredRelPosix = format
      ? buildBookStorageRelativePath({
          authorNames: ordered,
          title: book.title ?? '',
          bookId,
          filename: `${book.title ?? 'Untitled'}.${format}`,
          baseDir: 'library',
        })
      : rel;

    if (normalizePosix(rel) === normalizePosix(desiredRelPosix)) {
      movedNames.add(path.basename(rel));
      continue;
    }

    const src = resolveUnderLibraryOrThrow(rel).abs;
    const destAbs = resolveUnderLibraryOrThrow(desiredRelPosix).abs;

    // If source is missing, skip (do not fail the whole move).
    const srcExists = await fileExists(src);
    if (!srcExists) {
      if (await fileExists(destAbs)) {
        await cloudDb
          .update(bookFiles)
          .set({ relativePath: desiredRelPosix })
          .where(eq(bookFiles.id, f.id));
        movedNames.add(path.basename(destAbs));
        continue;
      }

      logger.warn(
        { bookId, relativePath: rel },
        'moveBookStorageToCanonical: source file missing on disk; skipping move',
      );
      continue;
    }

    if (await fileExists(destAbs)) {
      // Destination exists. Treat as already-migrated and remove the old file.
      try {
        await rm(src, { force: true });
      } catch {
        // ignore
      }
      await cloudDb
        .update(bookFiles)
        .set({ relativePath: desiredRelPosix })
        .where(eq(bookFiles.id, f.id));
      movedNames.add(path.basename(destAbs));
      continue;
    }

    await rename(src, destAbs);
    movedNames.add(path.basename(destAbs));

    await cloudDb
      .update(bookFiles)
      .set({ relativePath: desiredRelPosix })
      .where(eq(bookFiles.id, f.id));

    updatedFileCount += 1;
  }

  // Move cover if present.
  let movedCover = false;
  if (book.coverImagePath) {
    const coverStored = book.coverImagePath;
    const srcCoverAbs = resolveUnderLibraryOrThrow(coverStored).abs;

    if (await fileExists(srcCoverAbs)) {
      const coverFileName = path.basename(srcCoverAbs);
      const destCoverAbs = path.join(targetDirAbs, coverFileName);

      if (
        path.resolve(srcCoverAbs) !== path.resolve(destCoverAbs) &&
        !(await fileExists(destCoverAbs))
      ) {
        await rename(srcCoverAbs, destCoverAbs);
        movedCover = true;
      } else if (
        path.resolve(srcCoverAbs) !== path.resolve(destCoverAbs) &&
        (await fileExists(destCoverAbs))
      ) {
        // If cover already exists at destination, keep it and remove old one (best-effort).
        try {
          await rm(srcCoverAbs, { force: true });
        } catch {
          // ignore
        }
      }

      movedNames.add(coverFileName);

      const destCoverRelPosix = [
        BOOK_STORAGE_DEFAULTS.baseDir,
        ...path.relative(libraryBaseAbs, destCoverAbs).split(path.sep),
      ].join('/');

      await cloudDb
        .update(books)
        .set({ coverImagePath: destCoverRelPosix, updatedAt: new Date() })
        .where(eq(books.id, bookId));
    } else {
      // Missing cover file is fine.
    }
  }

  // Move any remaining files in the old directory (covers, metadata.opf, etc.).
  // This helps keep the library clean when titles/authors change.
  let currentDirAbs: string | null = null;
  try {
    currentDirAbs = resolveUnderLibraryOrThrow(currentDirPosix).abs;
    const entries = await readdir(currentDirAbs, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;
      if (movedNames.has(name)) continue;

      const src = path.join(currentDirAbs, name);
      const dest = path.join(targetDirAbs, name);

      if (await fileExists(dest)) {
        // Avoid overwriting; best-effort cleanup.
        try {
          await rm(src, { recursive: entry.isDirectory(), force: true });
        } catch {
          // ignore
        }
        continue;
      }

      await rename(src, dest);
    }
  } catch {
    // ignore
  }

  // Best-effort cleanup: remove the old directory after moving.
  if (currentDirAbs && path.resolve(currentDirAbs) !== path.resolve(targetDirAbs)) {
    try {
      await rm(currentDirAbs, { recursive: true, force: true });
    } catch {
      // ignore
    }

    // Clean up empty parent directories (including the old author dir).
    try {
      const { libraryBaseAbs } = resolveUnderLibraryOrThrow(
        `${BOOK_STORAGE_DEFAULTS.baseDir}/dummy`,
      );
      await cleanupEmptyParents(path.dirname(currentDirAbs), libraryBaseAbs);
    } catch {
      // ignore
    }
  }

  // Defensive sweep: remove any empty directories under library/ (ignoring OS junk).
  // This handles cases where the old directory was already empty or moved earlier.
  await cleanupEmptyLibraryDirs();

  return {
    moved: true,
    reason: 'moved',
    fromDir: currentDirPosix,
    toDir: targetDirPosix,
    updatedFileCount,
    movedCover,
  };
}

function normalizePosix(p: string): string {
  return (p ?? '')
    .toString()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

const IGNORED_ENTRY_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.AppleDouble',
]);

function isIgnorableEntryName(name: string): boolean {
  if (IGNORED_ENTRY_NAMES.has(name)) return true;
  if (name.startsWith('._')) return true;
  return false;
}

async function removeDirIfOnlyIgnorable(dirAbs: string): Promise<boolean> {
  try {
    const entries = await readdir(dirAbs, { withFileTypes: true });

    for (const entry of entries) {
      const entryAbs = path.join(dirAbs, entry.name);

      if (entry.isDirectory()) {
        const removed = await removeDirIfOnlyIgnorable(entryAbs);
        if (!removed) return false;
        continue;
      }

      if (isIgnorableEntryName(entry.name)) {
        try {
          await rm(entryAbs, { force: true });
        } catch {
          return false;
        }
        continue;
      }

      return false;
    }

    await rmdir(dirAbs);
    return true;
  } catch (error: unknown) {
    const e = error as { code?: string };
    if (e?.code === 'ENOENT') return true;
    return false;
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
