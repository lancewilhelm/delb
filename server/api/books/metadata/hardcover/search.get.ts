import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { getHardcoverToken } from '~~/server/utils/secrets/hardcover';

const GRAPHQL_ENDPOINT = 'https://api.hardcover.app/v1/graphql';

const SEARCH_QUERY = `
query SearchBooks($query: String!) {
  search(query: $query, query_type: "Book", per_page: 50) {
    results
  }
}
`;

function normalizeDateOnlyOrNull(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim();
  if (!v) return null;

  // Hardcover appears to return YYYY-MM-DD often. Keep date-only when it matches.
  const mDay = v.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (mDay) return mDay[1]!;
  return null;
}

function toNumberOrNull(input: unknown): number | null {
  if (typeof input === 'number' && !Number.isNaN(input)) return input;
  if (typeof input === 'string') {
    const v = input.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function uniqByLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/**
 * GET /api/books/metadata/hardcover/search?q=The%20Hobbit
 *
 * Server-side proxy to Hardcover GraphQL:
 * - Requires authenticated session
 * - Reads Hardcover token from global settings: settings.hardcoverToken
 * - Returns mapped "hits" array (best-effort), plus raw parsed payload for debugging.
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books/metadata/hardcover/search');

  // Auth required (keeps token server-side; also aligns with current settings endpoints)
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const query = getQuery(event);
  const q = query.q;

  if (!q || typeof q !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Search query parameter "q" is required',
    });
  }

  // Server-side token (never read from client-visible settings)
  const token = await getHardcoverToken();

  if (!token) {
    throw createError({
      statusCode: 412,
      statusMessage:
        'Hardcover token is not configured. Set it in Admin Settings → Metadata.',
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Delb/HardcoverMetadataProxy',
  };

  try {
    const resp = await $fetch<{
      data?: { search?: { results?: unknown } };
      errors?: unknown;
    }>(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers,
      body: {
        query: SEARCH_QUERY,
        variables: { query: q },
      },
      // h3/ofetch supports timeout in newer versions; keep as a safe hint.
      // If your runtime doesn't support it, it will be ignored.
      timeout: 15000,
    });

    if (resp?.errors) {
      throw createError({
        statusCode: 502,
        statusMessage: `Hardcover GraphQL errors: ${JSON.stringify(resp.errors)}`,
      });
    }

    const rawResults = resp?.data?.search?.results;

    // Hardcover's search.results may be a JSON string or already-parsed
    type HardcoverSearchContribution = {
      author?: {
        id?: unknown;
        name?: unknown;
        slug?: unknown;
      } | null;
      contribution?: unknown; // e.g. "Cover Artist", "Illustrator", etc.
    };

    type HardcoverSearchSeries = {
      details?: unknown; // sometimes contains "1", "3", etc
      position?: unknown; // sometimes numeric position
      series?: {
        name?: unknown;
        slug?: unknown;
      } | null;
    };

    type HardcoverSearchDoc = {
      id?: unknown;
      title?: unknown;
      author_names?: unknown; // not always reliable (can include non-author contributors)
      contributions?: unknown;
      contribution_types?: unknown; // e.g. ["Author","Cover Artist"]

      image?: { url?: unknown } | null;
      description?: unknown;
      slug?: unknown;

      release_date?: unknown;
      pages?: unknown;

      // We intentionally do NOT import Hardcover's `tags` (subjective).
      // Use `genres` as tags in Delb.
      tags?: unknown;
      genres?: unknown;

      featured_series?: unknown;
    };

    type HardcoverSearchHit = {
      document?: HardcoverSearchDoc | null;
    };

    type HardcoverSearchResultsParsed = {
      hits?: HardcoverSearchHit[];
    };

    let parsed: unknown = rawResults;
    if (typeof rawResults === 'string') {
      try {
        parsed = JSON.parse(rawResults) as unknown;
      } catch {
        parsed = {};
      }
    }

    const parsedObj = (parsed ?? {}) as HardcoverSearchResultsParsed;
    const hits = Array.isArray(parsedObj.hits) ? parsedObj.hits : [];

    const mapped = hits.map((hit) => {
      const doc = hit?.document ?? {};

      const contributionTypes = normalizeStringArray(doc.contribution_types)
        .map((s) => s.toLowerCase())
        .filter(Boolean);

      const hasCoverArtistRole = contributionTypes.includes('cover artist');
      const hasIllustratorRole = contributionTypes.includes('illustrator');
      const hasContributorRole = contributionTypes.includes('contributor');
      const hasCreatorRole = contributionTypes.includes('creator');
      const hasAuthorRole = contributionTypes.includes('author');

      /**
       * Authors:
       * - Prefer `contributions` with role-based filtering.
       * - Use `contribution_types` to help decide whether ambiguous/null roles should be trusted.
       *
       * Observations from raw hits:
       * - True authors often have `contribution: null` (or missing).
       * - Non-authors show `contribution: "Cover Artist"`, "Illustrator", etc.
       * - `author_names` sometimes contains non-authors (e.g. cover artists) so it is only a fallback.
       */
      let authors: string[] = [];
      if (Array.isArray(doc.contributions)) {
        const contribs = doc.contributions as HardcoverSearchContribution[];

        const names: string[] = [];
        for (const c of contribs) {
          const name =
            c?.author &&
            typeof c.author === 'object' &&
            typeof c.author.name === 'string'
              ? c.author.name.trim()
              : '';

          if (!name) continue;

          const roleRaw =
            typeof c?.contribution === 'string' ? c.contribution.trim() : '';
          const role = roleRaw.toLowerCase();

          // Exclude obvious non-author roles
          if (role === 'cover artist' || role === 'illustrator') continue;

          // If it's explicitly an author, keep it
          if (role === 'author') {
            names.push(name);
            continue;
          }

          // If role is blank/unknown:
          // - If Hardcover says this work has cover artists/illustrators/creators/etc,
          //   we still treat blank as "author" (Hardcover commonly uses null for authors).
          // - If the work does NOT indicate author role at all, be conservative and skip blanks.
          if (!role) {
            if (
              hasAuthorRole ||
              hasCoverArtistRole ||
              hasIllustratorRole ||
              hasContributorRole ||
              hasCreatorRole
            ) {
              names.push(name);
            }
          }
        }

        authors = uniqByLower(names);
      }

      // Fallback: doc.author_names (may contain non-author contributors)
      if (!authors.length && Array.isArray(doc.author_names)) {
        authors = uniqByLower(
          doc.author_names
            .filter((a): a is string => typeof a === 'string')
            .map((a) => a.trim())
            .filter(Boolean),
        );
      }

      /**
       * Tags:
       * - DO NOT use Hardcover `tags` (subjective).
       * - Use Hardcover `genres` only (more canonical).
       */
      const dedupedGenres = uniqByLower(normalizeStringArray(doc.genres));

      // Identifier strategy:
      // - Do NOT import Hardcover's ISBN list (too many).
      // - Import Hardcover book id as a stable identifier record.
      const hardcoverId =
        typeof doc.id === 'string' || typeof doc.id === 'number'
          ? String(doc.id)
          : null;

      const identifiers = hardcoverId
        ? [{ type: 'hardcover', value: hardcoverId }]
        : [];

      // Published date (date-only)
      const published = normalizeDateOnlyOrNull(doc.release_date);

      // Pages
      const pages = toNumberOrNull(doc.pages);

      // Series info (best effort)
      let series: string | null = null;
      let seriesIndex: number | null = null;
      if (doc.featured_series && typeof doc.featured_series === 'object') {
        const fs = doc.featured_series as HardcoverSearchSeries;
        series =
          fs.series &&
          typeof fs.series === 'object' &&
          typeof fs.series.name === 'string'
            ? fs.series.name
            : null;

        const idx = toNumberOrNull(fs.details) ?? toNumberOrNull(fs.position);
        seriesIndex = idx;
      }

      return {
        id: doc.id ?? null,
        title: typeof doc.title === 'string' ? doc.title : '',
        authors,
        cover:
          doc?.image && typeof doc.image === 'object' && 'url' in doc.image
            ? typeof (doc.image as { url?: unknown }).url === 'string'
              ? ((doc.image as { url?: string }).url ?? null)
              : null
            : null,
        description: typeof doc.description === 'string' ? doc.description : '',
        hardcover_slug: typeof doc.slug === 'string' ? doc.slug : '',

        // richer fields for import mapping
        genres: dedupedGenres,
        identifiers,
        published,
        pages,
        series,
        seriesIndex,
      };
    });

    return {
      success: true,
      data: {
        query: q,
        results: mapped,
        raw: parsed,
      },
    };
  } catch (error: unknown) {
    // Best-effort diagnostics without leaking sensitive headers
    const errObj = error as {
      message?: unknown;
      statusCode?: unknown;
      status?: unknown;
    };

    logger.error(
      {
        msg: typeof errObj?.message === 'string' ? errObj.message : undefined,
        status:
          typeof errObj?.statusCode === 'number'
            ? errObj.statusCode
            : typeof errObj?.status === 'number'
              ? errObj.status
              : undefined,
      },
      'Hardcover API error',
    );

    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch metadata from Hardcover',
    });
  }
});
