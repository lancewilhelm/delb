/**
 * Shared utilities for generating stored sort keys.
 *
 * Design goals:
 * - Small + deterministic (so we can backfill and keep stable ordering)
 * - Server-owned (clients should not implement their own variants)
 * - Extensible later (e.g. articles beyond "The", locale options, etc.)
 */

/**
 * Normalize whitespace for sort keys:
 * - trim
 * - collapse internal runs of whitespace to a single space
 */
function normalizeSpaces(input: string): string {
  return (input ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Calibre-style title sort key (lean v1):
 * - removes a leading "The " (case-insensitive)
 * - keeps original title otherwise
 *
 * Examples:
 * - "The Hobbit" -> "Hobbit"
 * - "the   Trial" -> "Trial"
 * - "Then We Came..." -> "Then We Came..." (does NOT strip; only "The " as a word)
 */
export function makeTitleSortKey(title: string): string {
  const t = normalizeSpaces(title);
  if (!t) return "";

  // Only strip the exact leading article word "The" followed by whitespace.
  // This ensures we don't transform titles like "Then..." or "Theatre...".
  const stripped = t.replace(/^the\s+/i, "");
  return stripped;
}

/**
 * Basic author sort key (lean v1):
 * - sorts by "last name" by moving the last token to the front
 * - output format: "Last, Rest"
 *
 * Notes / limitations (acceptable for v1; refine later if needed):
 * - Doesn't attempt complex surname parsing (e.g. "de la", "van", suffixes, etc.)
 * - If the name already contains a comma, we assume it's already in sort order
 *   and normalize whitespace only.
 *
 * Examples:
 * - "J. R. R. Tolkien" -> "Tolkien, J. R. R."
 * - "Tolkien, J. R. R." -> "Tolkien, J. R. R."
 * - "Plato" -> "Plato"
 */
export function makeAuthorSortKey(name: string): string {
  const n = normalizeSpaces(name);
  if (!n) return "";

  // If already in "Last, First" form, keep it (just normalized).
  if (n.includes(",")) return n;

  const parts = n.split(" ").filter(Boolean);
  if (parts.length <= 1) return n;

  const last = parts[parts.length - 1] ?? "";
  const rest = parts.slice(0, -1).join(" ").trim();

  return rest ? `${last}, ${rest}` : last;
}
