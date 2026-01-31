import path from 'node:path';

/**
 * Create a filesystem-safe segment (directory/file name component).
 *
 * Goals:
 * - stable + readable
 * - avoids path traversal (`..`, slashes)
 * - avoids Windows reserved chars
 * - trims trailing dots/spaces (Windows)
 *
 * This is intentionally conservative for an MVP. You can later swap to a more
 * sophisticated slugger while keeping the same exported API.
 */
export function toSafePathSegment(input: string, fallback = 'unknown'): string {
  const raw = (input ?? '').toString().trim();
  if (!raw) return fallback;

  // Normalize Unicode to reduce weird equivalence issues (e.g. accents)
  let s = raw.normalize('NFKC');

  // Replace path separators & common unsafe characters with spaces
  s = s.replace(/[\\/]/g, ' ');

  // Avoid embedding control characters in regex literals (lint rule: `no-control-regex`).
  // Filter control chars via codepoints instead of regex.
  s = Array.from(s)
    .filter((ch) => {
      const cp = ch.codePointAt(0);
      if (cp === undefined) return false;
      // Exclude ASCII control chars + DEL
      return !(cp <= 0x1f || cp === 0x7f);
    })
    .join('');

  // Windows-reserved characters (NUL already removed above)
  s = s.replace(/[<>:"|?*]/g, ' ');

  // Avoid dot segments / traversal
  s = s.replace(/\.\.+/g, '.');
  s = s.replace(/^\.+/, ''); // leading dots
  s = s.replace(/\.+$/, ''); // trailing dots

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Windows: cannot end with space or dot
  s = s.replace(/[. ]+$/g, '');

  if (!s) return fallback;

  // Keep paths reasonably short (per-segment). 80 is arbitrary but practical.
  if (s.length > 80) s = s.slice(0, 80).trim();

  return s || fallback;
}

/**
 * Build the relative storage path for a book file:
 *   library/{author}/{title}/{filename}
 *
 * Returns a *relative* POSIX-style path (forward slashes) suitable for storing in DB.
 */
export function buildBookRelativePath(opts: {
  author: string;
  title: string;
  filename: string;
}): string {
  const authorDir = toSafePathSegment(opts.author, 'Unknown Author');
  const titleDir = toSafePathSegment(opts.title, 'Untitled');
  const fileName = toSafePathSegment(opts.filename, 'book');

  // Always store as a forward-slash path in DB for portability.
  // (We'll resolve to an absolute FS path at runtime server-side.)
  return ['library', authorDir, titleDir, fileName].join('/');
}

/**
 * Resolve the on-disk absolute path for a relative path stored in DB.
 * This avoids callers needing to know the process cwd details.
 */
export function resolveDataPath(relativePath: string): string {
  // `process.cwd()` should be the project root when running Nuxt/Nitro locally.
  // We normalize to the current OS path style.
  return path.resolve(process.cwd(), relativePath);
}
