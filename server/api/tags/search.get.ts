import { like } from "drizzle-orm";
import { cloudDb } from "~~/server/utils/db/cloud";
import { tags } from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

/**
 * GET /api/tags/search?q=...
 *
 * Admin-only endpoint for tag typeahead.
 *
 * Lean behavior:
 * - Requires admin/owner.
 * - Returns up to `limit` results (default 8, max 20).
 * - Pragmatic "fuzzy-ish" search using SQL LIKE across:
 *   - prefix match
 *   - contains match
 *
 * Notes:
 * - SQLite doesn't have great fuzzy search without FTS.
 * - We pull a small set and score in-memory for stable ordering.
 */
export default defineEventHandler(async (event) => {
  logger.debug("GET /api/tags/search");

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (
    !session ||
    (session.user.role !== "admin" && session.user.role !== "owner")
  ) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const { q, limit } = getQuery(event) as {
    q?: string;
    limit?: string;
  };

  const raw = (q ?? "").toString().trim();

  if (!raw) {
    return {
      success: true,
      data: {
        results: [],
      },
    };
  }

  const requestedLimit = Number(limit ?? 8);
  const take = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(20, Math.floor(requestedLimit)))
    : 8;

  // Defensive: escape LIKE wildcards. We intentionally do NOT treat user input as a pattern.
  // SQLite LIKE supports % and _ as wildcards; backslash escaping works in many setups,
  // but to stay simple we just replace them with escaped versions. Drizzle will parameterize it.
  const escapeLike = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

  const needle = escapeLike(raw);
  const prefix = `${needle}%`;
  const contains = `%${needle}%`;

  try {
    const prefixRows = await cloudDb
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(like(tags.name, prefix))
      .limit(take);

    const containsRows = await cloudDb
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(like(tags.name, contains))
      .limit(Math.max(take * 5, 25));

    const merged = [...prefixRows, ...containsRows];

    const seen = new Set<string>();
    const unique = merged.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    const lowerNeedle = raw.toLowerCase();

    const scored = unique
      .map((r) => {
        const name = r.name ?? "";
        const lower = name.toLowerCase();

        const starts = lower.startsWith(lowerNeedle);
        const idx = lower.indexOf(lowerNeedle);

        // Smaller is better
        const score =
          (starts ? 0 : 100) +
          (idx >= 0 ? idx : 10_000) +
          Math.min(name.length, 10_000) / 10_000;

        return { ...r, score };
      })
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        const aLen = a.name.length;
        const bLen = b.name.length;
        if (aLen !== bLen) return aLen - bLen;
        return a.name.localeCompare(b.name);
      })
      .slice(0, take)
      .map(({ id, name }) => ({ id, name }));

    return {
      success: true,
      data: {
        results: scored,
      },
    };
  } catch (error: unknown) {
    logger.error(error, "GET /api/tags/search: failed");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to search tags",
    });
  }
});
