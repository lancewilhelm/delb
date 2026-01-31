import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { and, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { books, collectionBooks, collectionMembers } from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

/**
 * GET /api/books/:id/cover-source
 *
 * Returns the TRUE original cover image bytes for a book (source cover),
 * without the client needing to guess the file extension.
 *
 * Cover model:
 * - Thumbnail (used almost everywhere): `.../thumb.webp` (stored in `books.coverImagePath`)
 * - Source/original (served here on demand): one of:
 *   - `.../cover.<ext>` (preferred)
 *   - `.../cover.source.<ext>` (legacy/alternate)
 *   - `.../source.<ext>` (legacy/alternate)
 *   - (Calibre import fallback) `.../cover.jpg|jpeg|png|webp`
 *
 * Security:
 * - Requires authenticated user.
 * - Requires the user be a member of at least one collection containing the book.
 * - Prevents path traversal by resolving under `<projectRoot>/library`.
 *
 * Response:
 * - 200 with image bytes
 * - 404 if no cover source exists (or user cannot see the book)
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books/:id/cover-source');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const id = getRouterParam(event, 'id');
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  }

  // Visibility: user must be in at least one collection that contains this book.
  const memberships = await cloudDb
    .select({ collectionId: collectionMembers.collectionId })
    .from(collectionMembers)
    .where(eq(collectionMembers.userId, session.user.id));

  const memberCollectionIds = Array.from(
    new Set(memberships.map((m) => m.collectionId)),
  ).filter(Boolean);

  if (!memberCollectionIds.length) {
    // Avoid leaking existence
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }

  const visible = await cloudDb
    .select({ book: books })
    .from(books)
    .innerJoin(
      collectionBooks,
      and(eq(collectionBooks.bookId, books.id), eq(books.id, id)),
    )
    .where(inArray(collectionBooks.collectionId, memberCollectionIds))
    .limit(1);

  const book = visible[0]?.book;
  if (!book) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }

  const coverImagePath = (book.coverImagePath ?? '').toString().trim();
  if (!coverImagePath) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }

  const libraryBaseAbs = path.resolve(process.cwd(), 'library');

  const normalizePosix = (p: string) =>
    (p ?? '')
      .toString()
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '');

  const stored = normalizePosix(coverImagePath);

  // Cover paths are stored as `library/...` relative POSIX paths.
  const relFromLibraryPosix = stored.replace(/^library\//, '');
  const coverDirPosix = path.posix.dirname(relFromLibraryPosix);

  // Candidate source filenames (ordered by preference)
  const candidates = [
    // New canonical source naming
    'cover.jpg',
    'cover.jpeg',
    'cover.png',
    'cover.webp',
    'cover.gif',
    'cover.svg',
    'cover.avif',
    'cover.tiff',
    // Alternate/legacy naming
    'cover.source.jpg',
    'cover.source.jpeg',
    'cover.source.png',
    'cover.source.webp',
    'source.jpg',
    'source.jpeg',
    'source.png',
    'source.webp',
    // Calibre fallback (original convention)
    'cover.jpg',
    'cover.jpeg',
    'cover.png',
  ];

  const uniqueCandidates = Array.from(new Set(candidates));

  const resolveUnderLibrary = (relPosix: string) => {
    const relOs = relPosix.split('/').join(path.sep);
    const abs = path.resolve(libraryBaseAbs, relOs);

    const relToBase = path.relative(libraryBaseAbs, abs);
    if (relToBase.startsWith('..') || relToBase.includes(`..${path.sep}`)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid path' });
    }

    return abs;
  };

  const contentTypeFromExt = (ext: string) => {
    const e = (ext ?? '').toLowerCase();
    if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
    if (e === '.png') return 'image/png';
    if (e === '.webp') return 'image/webp';
    if (e === '.gif') return 'image/gif';
    if (e === '.svg') return 'image/svg+xml';
    if (e === '.avif') return 'image/avif';
    if (e === '.tif' || e === '.tiff') return 'image/tiff';
    return 'application/octet-stream';
  };

  // Find first existing candidate on disk
  let chosenAbs: string | null = null;
  for (const filename of uniqueCandidates) {
    const relPosix =
      coverDirPosix === '.' ? filename : `${coverDirPosix}/${filename}`;
    const abs = resolveUnderLibrary(relPosix);

    try {
      const st = await stat(abs);
      if (st.isFile() && st.size > 0) {
        chosenAbs = abs;
        break;
      }
    } catch {
      // not found; keep scanning
    }
  }

  if (!chosenAbs) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }

  const ext = path.extname(chosenAbs).toLowerCase();
  const contentType = contentTypeFromExt(ext);

  // Source covers are immutable in practice; cache longer than thumbs.
  // (If/when covers can be changed, the URL remains stable; clients may need cache-busting query params.)
  setHeader(event, 'Content-Type', contentType);
  setHeader(event, 'Cache-Control', 'public, max-age=86400');

  const bytes = await readFile(chosenAbs);
  return bytes;
});
