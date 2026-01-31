import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { logger } from '~/utils/logger';

/**
 * Serves cover images stored under:
 *   <projectRoot>/library/<author>/<title>/(thumb.webp | cover.<ext>)
 *
 * Request path:
 *   GET /api/media/covers/<relative path under library>
 *
 * Optional query:
 *   - kind=thumb|source
 *
 * Behavior when `kind` is provided:
 * - kind=thumb: if the requested path is a directory or a source-like filename, serve `thumb.webp` in that directory
 * - kind=source: if the requested path is a directory, or `thumb.webp`, serve the first existing `cover.<ext>` (or fallback candidates) in that directory
 *
 * Examples:
 * - /api/media/covers/Author/Book  (kind=thumb|source)   -> resolves within that folder
 * - /api/media/covers/Author/Book/thumb.webp?kind=source -> serves full-res cover
 *
 * Security:
 * - Prevents path traversal by resolving and ensuring the resolved path
 *   stays within the `library` directory.
 *
 * Notes:
 * - This endpoint is intentionally minimal for the MVP.
 * - If you later want auth gating, you can add session checks here.
 */
export default defineEventHandler(async (event) => {
  const raw = getRouterParam(event, 'path');
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split('/').filter(Boolean)
      : [];

  const kindRaw = getQuery(event)?.kind;
  const kind =
    typeof kindRaw === 'string' ? kindRaw.trim().toLowerCase() : null;

  if (kind && kind !== 'thumb' && kind !== 'source') {
    throw createError({ statusCode: 400, statusMessage: 'Invalid kind' });
  }

  // Base directory for all book assets
  const booksBaseAbs = path.resolve(process.cwd(), 'library');

  // Join provided path under the base dir
  // Note: route params come URL-decoded by Nitro, but we decode defensively.
  const requestedRel = parts.map((p) => decodeURIComponent(p)).join(path.sep);
  const requestedAbsInitial = path.resolve(booksBaseAbs, requestedRel);

  // Path traversal protection: ensure requestedAbs is within booksBaseAbs
  const relToBaseInitial = path.relative(booksBaseAbs, requestedAbsInitial);
  if (
    relToBaseInitial.startsWith('..') ||
    relToBaseInitial.includes(`..${path.sep}`)
  ) {
    logger.warn(
      { requestedRel },
      'GET /api/media/covers: blocked path traversal attempt',
    );
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' });
  }

  const isFile = async (absPath: string) => {
    try {
      const st = await stat(absPath);
      return st.isFile();
    } catch {
      return false;
    }
  };

  const isDir = async (absPath: string) => {
    try {
      const st = await stat(absPath);
      return st.isDirectory();
    } catch {
      return false;
    }
  };

  const resolveToThumbPath = async (abs: string): Promise<string | null> => {
    const dirAbs = (await isDir(abs)) ? abs : path.dirname(abs);
    const thumbAbs = path.join(dirAbs, 'thumb.webp');
    if (await isFile(thumbAbs)) return thumbAbs;
    return null;
  };

  const resolveToSourcePath = async (abs: string): Promise<string | null> => {
    const dirAbs = (await isDir(abs)) ? abs : path.dirname(abs);

    // Preference order: canonical-ish cover names, then legacy names, then Calibre's cover.*
    const candidates = [
      'cover.jpg',
      'cover.jpeg',
      'cover.png',
      'cover.webp',
      'cover.gif',
      'cover.svg',
      'cover.avif',
      'cover.tiff',
      'cover.source.jpg',
      'cover.source.jpeg',
      'cover.source.png',
      'cover.source.webp',
      'source.jpg',
      'source.jpeg',
      'source.png',
      'source.webp',
      'cover.jpg',
      'cover.jpeg',
      'cover.png',
    ];

    const seen = new Set<string>();
    for (const name of candidates) {
      if (seen.has(name)) continue;
      seen.add(name);

      const candidateAbs = path.join(dirAbs, name);
      if (await isFile(candidateAbs)) return candidateAbs;
    }

    return null;
  };

  // Determine final requested path (may be rewritten by `kind`)
  let requestedAbs = requestedAbsInitial;

  if (kind === 'thumb') {
    // If the user asked for a thumb explicitly, always attempt to serve thumb.webp from the folder.
    const thumbAbs = await resolveToThumbPath(requestedAbsInitial);
    if (!thumbAbs) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' });
    }
    requestedAbs = thumbAbs;
  } else if (kind === 'source') {
    const sourceAbs = await resolveToSourcePath(requestedAbsInitial);
    if (!sourceAbs) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' });
    }
    requestedAbs = sourceAbs;
  }

  // Only allow common image extensions for covers
  const ext = path.extname(requestedAbs).toLowerCase();
  const allowed = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.svg',
    '.avif',
    '.tif',
    '.tiff',
  ]);
  if (!allowed.has(ext)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Unsupported file type',
    });
  }

  try {
    const buf = await readFile(requestedAbs);

    const contentType =
      ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : ext === '.svg'
                ? 'image/svg+xml'
                : ext === '.avif'
                  ? 'image/avif'
                  : ext === '.tif' || ext === '.tiff'
                    ? 'image/tiff'
                    : 'application/octet-stream';

    setHeader(event, 'Content-Type', contentType);
    // Cache a bit in dev too; adjust later (or make immutable if fingerprinted)
    setHeader(event, 'Cache-Control', 'public, max-age=3600');

    return buf;
  } catch {
    // File not found (or unreadable)
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }
});
