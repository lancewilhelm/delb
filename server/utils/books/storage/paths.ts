import path from "node:path";

import { toSafePathSegment } from "~~/server/utils/books/fs";

/**
 * Centralized storage path generation for book folders and files.
 *
 * Goals:
 * - Deterministic: given the same metadata + ids, paths are stable.
 * - Human-browsable: author + title are visible in the filesystem.
 * - Collision-resistant: includes a short id slice in the book folder.
 * - Multi-author support: first two authors, then "et al" (per product decision).
 * - Portable: store paths as POSIX-style strings in DB (forward slashes).
 *
 * Current layout (relative paths stored in DB):
 *   library/<author-folder>/<title-folder> (<id8>)/<filename>
 *
 * Examples:
 *   library/Terry Pratchett/Guards! Guards! (a1b2c3d4)/Guards! Guards!.epub
 *   library/Terry Pratchett & Neil Gaiman et al/Good Omens (deadbeef)/Good Omens.epub
 *
 * Notes:
 * - We deliberately do NOT bake "sort keys" into filesystem names; we use display names.
 * - The short id slice prevents overwrites when two books share author+title.
 */

/** Stored paths are always POSIX-style (forward slashes) for portability. */
export type PosixRelativePath = string;

export type BookStorageLayout = "library";

/** The canonical directory and file names we manage today. */
export const BOOK_STORAGE_DEFAULTS = Object.freeze({
  baseDir: "library" as const,
  coverFilename: "cover.webp" as const,
  idSliceLength: 8 as const,
});

export function normalizeSpaces(input: string): string {
  return (input ?? "").toString().replace(/\s+/g, " ").trim();
}

export function getBookIdSlice(
  bookId: string,
  len = BOOK_STORAGE_DEFAULTS.idSliceLength,
): string {
  const raw = (bookId ?? "").toString().trim();
  if (!raw) return "unknown";
  return raw.slice(0, Math.max(1, Math.min(32, Math.floor(len))));
}

export type AuthorFolderOptions = {
  /**
   * Author display names in desired order (position order).
   * If empty/missing, we fall back to "Unknown Author".
   */
  authors: string[];

  /**
   * Maximum authors to include before adding "et al".
   * Per decision: include first 2 then "et al" for 3+.
   */
  maxAuthorsBeforeEtAl?: number;

  /** Segment fallback used when author list is empty. */
  fallback?: string;
};

export function makeAuthorFolderName(opts: AuthorFolderOptions): string {
  const maxAuthorsBeforeEtAl = opts.maxAuthorsBeforeEtAl ?? 2;
  const fallback = opts.fallback ?? "Unknown Author";

  const names = (opts.authors ?? [])
    .map((a) => normalizeSpaces(a))
    .filter((a) => a.length > 0);

  if (!names.length) return fallback;

  const first = names[0] ?? fallback;

  if (names.length === 1) return first;

  const second = names[1] ?? "";
  const moreThanTwo = names.length > maxAuthorsBeforeEtAl;

  // Format: "A & B" or "A & B et al"
  const base = second ? `${first} & ${second}` : first;
  return moreThanTwo ? `${base} et al` : base;
}

export type BookFolderOptions = {
  title: string;
  bookId: string;
};

export function makeBookFolderName(opts: BookFolderOptions): string {
  const title = normalizeSpaces(opts.title);
  const safeTitle = toSafePathSegment(title, "Untitled");

  const idSlice = getBookIdSlice(opts.bookId);
  // Keep the id slice visible and easy to spot for uniqueness.
  return `${safeTitle} (${idSlice})`;
}

export type BuildBookPathInput = {
  /**
   * The ordered author display names for this book.
   * Should be in the same order used for display (position order).
   */
  authorNames: string[];

  /** Book title (display). */
  title: string;

  /** Book id (UUID). */
  bookId: string;

  /**
   * Target filename (e.g. "My Book.epub" or "cover.webp").
   * This will be sanitized per-segment.
   */
  filename: string;

  /**
   * Base directory (defaults to "books").
   * This is here for future flexibility; keep default for now.
   */
  baseDir?: BookStorageLayout;
};

/**
 * Build a relative DB path (POSIX-style) for any book-associated file.
 * This is the single canonical way to compute "where should this file live?"
 */
export function buildBookStorageRelativePath(
  input: BuildBookPathInput,
): PosixRelativePath {
  const baseDir = input.baseDir ?? BOOK_STORAGE_DEFAULTS.baseDir;

  const authorFolderDisplay = makeAuthorFolderName({
    authors: input.authorNames ?? [],
    maxAuthorsBeforeEtAl: 2,
  });

  const authorDir = toSafePathSegment(authorFolderDisplay, "Unknown Author");

  const bookDir = toSafePathSegment(
    makeBookFolderName({ title: input.title, bookId: input.bookId }),
    "Untitled",
  );

  const fileName = toSafePathSegment(normalizeSpaces(input.filename), "file");

  return [baseDir, authorDir, bookDir, fileName].join("/");
}

export type CanonicalBookPaths = {
  /**
   * Directory for the book folder, relative (POSIX):
   *   books/<author>/<title (id8)>
   */
  bookDir: PosixRelativePath;

  /**
   * Canonical cover path (relative POSIX):
   *   books/<author>/<title (id8)>/cover.webp
   */
  coverPath: PosixRelativePath;

  /**
   * Canonical EPUB path (relative POSIX), based on title:
   *   books/<author>/<title (id8)>/<title>.epub
   */
  epubPath: PosixRelativePath;
};

/**
 * Compute canonical locations we manage for a book:
 * - book folder dir
 * - cover.webp
 * - title-based epub filename
 *
 * Note: This does not verify existence; it's pure path computation.
 */
export function getCanonicalBookPaths(opts: {
  authorNames: string[];
  title: string;
  bookId: string;
}): CanonicalBookPaths {
  const baseDir = BOOK_STORAGE_DEFAULTS.baseDir;

  const authorFolderDisplay = makeAuthorFolderName({
    authors: opts.authorNames ?? [],
    maxAuthorsBeforeEtAl: 2,
  });

  const authorDir = toSafePathSegment(authorFolderDisplay, "Unknown Author");
  const bookFolder = toSafePathSegment(
    makeBookFolderName({ title: opts.title, bookId: opts.bookId }),
    "Untitled",
  );

  const bookDir = [baseDir, authorDir, bookFolder].join("/");

  const titleSafe = toSafePathSegment(normalizeSpaces(opts.title), "Untitled");
  const epubFilename = `${titleSafe}.epub`;

  return {
    bookDir,
    coverPath: [bookDir, BOOK_STORAGE_DEFAULTS.coverFilename].join("/"),
    epubPath: [bookDir, toSafePathSegment(epubFilename, "book.epub")].join("/"),
  };
}

/**
 * Utilities for converting between POSIX DB paths and OS paths.
 * Keep these in one place so we do not accidentally introduce Windows separators into the DB.
 */
export function posixToOsPath(posixPath: PosixRelativePath): string {
  return posixPath.split("/").join(path.sep);
}

export function osToPosixPath(osPath: string): PosixRelativePath {
  return osPath.split(path.sep).join("/");
}
