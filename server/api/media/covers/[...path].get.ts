import path from "node:path";
import { readFile } from "node:fs/promises";

import { logger } from "~/utils/logger";

/**
 * Serves cover images stored under:
 *   <projectRoot>/books/<author>/<title>/cover.jpg (or other image types)
 *
 * Request path:
 *   GET /api/media/covers/<relative path under books>
 *
 * Example:
 *   /api/media/covers/Matt Dinniman/Dungeon Crawler Carl/cover.jpg
 *
 * Security:
 * - Prevents path traversal by resolving and ensuring the resolved path
 *   stays within the `books` directory.
 *
 * Notes:
 * - This endpoint is intentionally minimal for the MVP.
 * - If you later want auth gating, you can add session checks here.
 */
export default defineEventHandler(async (event) => {
  const raw = getRouterParam(event, "path");
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split("/").filter(Boolean)
      : [];

  // Base directory for all book assets
  const booksBaseAbs = path.resolve(process.cwd(), "books");

  // Join provided path under the base dir
  // Note: route params come URL-decoded by Nitro, but we decode defensively.
  const requestedRel = parts.map((p) => decodeURIComponent(p)).join(path.sep);
  const requestedAbs = path.resolve(booksBaseAbs, requestedRel);

  // Path traversal protection: ensure requestedAbs is within booksBaseAbs
  const relToBase = path.relative(booksBaseAbs, requestedAbs);
  // NOTE: `path.relative(...)` returns a relative path in normal usage; we rely on `relToBase` checks below.

  // The above `isOutside` logic can be simplified, but kept explicit for clarity:
  // - If rel starts with ".." => outside
  // - `path.relative` never returns an absolute path in normal cases, but we keep checks conservative.
  if (relToBase.startsWith("..") || relToBase.includes(`..${path.sep}`)) {
    logger.warn(
      { requestedRel },
      "GET /api/media/covers: blocked path traversal attempt",
    );
    throw createError({ statusCode: 400, statusMessage: "Invalid path" });
  }

  // Only allow common image extensions for covers
  const ext = path.extname(requestedAbs).toLowerCase();
  const allowed = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]);
  if (!allowed.has(ext)) {
    throw createError({
      statusCode: 400,
      statusMessage: "Unsupported file type",
    });
  }

  try {
    const buf = await readFile(requestedAbs);

    const contentType =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : ext === ".svg"
                ? "image/svg+xml"
                : "application/octet-stream";

    setHeader(event, "Content-Type", contentType);
    // Cache a bit in dev too; adjust later (or make immutable if fingerprinted)
    setHeader(event, "Cache-Control", "public, max-age=3600");

    return buf;
  } catch {
    // File not found (or unreadable)
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
});
