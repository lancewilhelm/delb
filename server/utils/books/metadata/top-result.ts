import { logger } from '~/utils/logger';
import { cloudDb } from '~~/server/utils/db/cloud';
import { globalSettings } from '~/utils/db/schema';
import { getHardcoverToken } from '~~/server/utils/secrets/hardcover';

type MetadataProviderKey = 'googleBooks' | 'hardcover';

export type GoogleBookVolumeInfo = {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  industryIdentifiers?: Array<{ type: string; identifier: string }>;
  pageCount?: number;
  categories?: string[];
  // non-standard: used by our Hardcover mapping
  series?: string;
  seriesIndex?: number;
  imageLinks?: { thumbnail?: string; smallThumbnail?: string };
  language?: string;
};

export type GoogleBookItem = {
  id: string;
  volumeInfo: GoogleBookVolumeInfo;
};

export type FetchTopMetadataResult =
  | {
      ok: true;
      provider: MetadataProviderKey;
      item: GoogleBookItem;
    }
  | {
      ok: false;
      provider: MetadataProviderKey;
      statusCode: number;
      message: string;
    };

function normalizeIdentifierValue(input: unknown): string {
  const v = (input ?? '').toString().trim();
  return v.replace(/[\s-]+/g, '');
}

function toNonEmptyStringOrUndef(input: unknown): string | undefined {
  const v = typeof input === 'string' ? input.trim() : '';
  return v ? v : undefined;
}

function toStringArrayOrUndef(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

function toNumberOrUndef(input: unknown): number | undefined {
  if (typeof input === 'number' && !Number.isNaN(input)) return input;
  if (typeof input === 'string' && input.trim()) {
    const n = Number(input);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

// NOTE: Intentionally no query shaping here.
// We pass raw user input through to the provider.

/**
 * Reads the app's default metadata provider from global settings.
 * Falls back to googleBooks when missing/invalid.
 */
export async function getDefaultMetadataProvider(): Promise<MetadataProviderKey> {
  try {
    const rows = await cloudDb
      .select({ settings: globalSettings.settings })
      .from(globalSettings)
      .limit(1);

    const raw = rows[0]?.settings as unknown;
    const provider = (raw as { metadataProvider?: unknown })?.metadataProvider;

    if (provider === 'hardcover') return 'hardcover';
    return 'googleBooks';
  } catch (e) {
    logger.debug(e, 'getDefaultMetadataProvider: failed, falling back');
    return 'googleBooks';
  }
}

type GoogleBooksResponse = {
  kind?: string;
  totalItems?: number;
  items?: GoogleBookItem[];
};

async function fetchTopGoogleBookItem(
  query: string,
): Promise<FetchTopMetadataResult> {
  try {
    const resp = await $fetch<GoogleBooksResponse>(
      'https://www.googleapis.com/books/v1/volumes',
      {
        params: {
          q: query,
          maxResults: 1,
        },
      },
    );

    const item = resp?.items?.[0];
    if (!item) {
      return {
        ok: false,
        provider: 'googleBooks',
        statusCode: 404,
        message: 'No results found.',
      };
    }

    return { ok: true, provider: 'googleBooks', item };
  } catch (e) {
    logger.error(e, 'fetchTopGoogleBookItem: upstream error');
    return {
      ok: false,
      provider: 'googleBooks',
      statusCode: 502,
      message: 'Failed to fetch metadata from Google Books.',
    };
  }
}

/**
 * Minimal mapped Hardcover item used by our Google-like conversion.
 * (We call Hardcover GraphQL directly here and map only what we need.)
 */
type HardcoverSearchMappedItem = {
  id: number | string | null;
  title: string;
  authors: string[];
  cover: string | null;
  description: string;
  hardcover_slug: string;
  genres?: string[];
  identifiers?: Array<{ type: 'hardcover'; value: string }>;
  published?: string | null;
  pages?: number | null;
  series?: string | null;
  seriesIndex?: number | null;
  publisher?: string | null;
  language?: string | null;
};

async function fetchTopHardcoverAsGoogleLikeItem(
  query: string,
): Promise<FetchTopMetadataResult> {
  const token = await getHardcoverToken();
  if (!token) {
    return {
      ok: false,
      provider: 'hardcover',
      statusCode: 412,
      message:
        'Hardcover token is not configured. Set it in Admin Settings → Metadata.',
    };
  }

  const GRAPHQL_ENDPOINT = 'https://api.hardcover.app/v1/graphql';
  const SEARCH_QUERY = `
query SearchBooks($query: String!) {
  search(query: $query, query_type: "Book", per_page: 50) {
    results
  }
}
`;

  try {
    const resp = await $fetch<{
      data?: { search?: { results?: unknown } };
      errors?: unknown;
    }>(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'delb/HardcoverMetadataProxy',
      },
      body: {
        query: SEARCH_QUERY,
        variables: { query },
      },
      timeout: 15000,
    });

    if (resp?.errors) {
      return {
        ok: false,
        provider: 'hardcover',
        statusCode: 502,
        message: `Hardcover GraphQL errors: ${JSON.stringify(resp.errors)}`,
      };
    }

    // NOTE:
    // Hardcover's `search.results` comes back as JSON string or already-parsed object.
    let parsed: unknown = resp?.data?.search?.results;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed) as unknown;
      } catch {
        parsed = {};
      }
    }

    const hits = Array.isArray((parsed as { hits?: unknown })?.hits)
      ? ((parsed as { hits: Array<{ document?: unknown }> }).hits ?? [])
      : [];

    const topDoc = hits[0]?.document as Record<string, unknown> | undefined;
    if (!topDoc) {
      return {
        ok: false,
        provider: 'hardcover',
        statusCode: 404,
        message: 'No results found.',
      };
    }

    // We intentionally keep this mapping aligned with our existing server proxy mapping.
    // If you already have a proxy endpoint, prefer calling that instead.
    const idRaw = topDoc.id;
    const id =
      typeof idRaw === 'string' || typeof idRaw === 'number'
        ? String(idRaw)
        : '';

    const title = toNonEmptyStringOrUndef(topDoc.title);
    const description = toNonEmptyStringOrUndef(topDoc.description);

    // Authors: best-effort from `author_names` (the richer filtering lives in the proxy endpoint)
    const authors = toStringArrayOrUndef(topDoc.author_names);

    const imageUrl =
      topDoc.image &&
      typeof topDoc.image === 'object' &&
      topDoc.image !== null &&
      'url' in topDoc.image
        ? toNonEmptyStringOrUndef(
            (topDoc.image as { url?: unknown }).url as unknown,
          )
        : undefined;

    const genres = toStringArrayOrUndef(topDoc.genres);

    const published = toNonEmptyStringOrUndef(topDoc.release_date);
    const pages = toNumberOrUndef(topDoc.pages);

    // Series: best-effort from featured_series shape
    let series: string | undefined;
    let seriesIndex: number | undefined;
    const fs = topDoc.featured_series as unknown;
    if (fs && typeof fs === 'object') {
      const fsObj = fs as Record<string, unknown>;
      const seriesObj = fsObj.series as unknown;
      if (seriesObj && typeof seriesObj === 'object') {
        series = toNonEmptyStringOrUndef(
          (seriesObj as { name?: unknown }).name,
        );
      }
      seriesIndex =
        toNumberOrUndef(fsObj.details) ?? toNumberOrUndef(fsObj.position);
    }

    const hardcoverLike: HardcoverSearchMappedItem = {
      id: id || null,
      title: title ?? '',
      authors: authors ?? [],
      cover: imageUrl ?? null,
      description: description ?? '',
      hardcover_slug: toNonEmptyStringOrUndef(topDoc.slug) ?? '',
      genres,
      identifiers: id ? [{ type: 'hardcover', value: id }] : [],
      published: published ?? null,
      pages: pages ?? null,
      series: series ?? null,
      seriesIndex: seriesIndex ?? null,
    };

    // Convert to the Google-like item our importers already understand.
    const categories = Array.isArray(hardcoverLike.genres)
      ? hardcoverLike.genres
      : undefined;

    const industryIdentifiers = Array.isArray(hardcoverLike.identifiers)
      ? hardcoverLike.identifiers
          .map((x) => {
            if (!x || x.type !== 'hardcover') return null;
            const v = normalizeIdentifierValue(x.value);
            if (!v) return null;
            return { type: 'HARDCOVER', identifier: v };
          })
          .filter((x): x is { type: string; identifier: string } => x !== null)
      : undefined;

    const googleLike: GoogleBookItem = {
      id: String(hardcoverLike.id ?? ''),
      volumeInfo: {
        title: hardcoverLike.title || undefined,
        authors:
          hardcoverLike.authors && hardcoverLike.authors.length
            ? hardcoverLike.authors
            : undefined,
        publisher: toNonEmptyStringOrUndef(hardcoverLike.publisher),
        publishedDate: toNonEmptyStringOrUndef(hardcoverLike.published),
        description: hardcoverLike.description || undefined,
        language: toNonEmptyStringOrUndef(hardcoverLike.language),
        categories: categories && categories.length ? categories : undefined,
        industryIdentifiers:
          industryIdentifiers && industryIdentifiers.length
            ? industryIdentifiers
            : undefined,
        pageCount:
          typeof hardcoverLike.pages === 'number' &&
          !Number.isNaN(hardcoverLike.pages)
            ? hardcoverLike.pages
            : undefined,
        series: toNonEmptyStringOrUndef(hardcoverLike.series),
        seriesIndex:
          typeof hardcoverLike.seriesIndex === 'number' &&
          !Number.isNaN(hardcoverLike.seriesIndex)
            ? hardcoverLike.seriesIndex
            : undefined,
        imageLinks: hardcoverLike.cover
          ? { thumbnail: hardcoverLike.cover }
          : undefined,
      },
    };

    return { ok: true, provider: 'hardcover', item: googleLike };
  } catch (e) {
    logger.error(e, 'fetchTopHardcoverAsGoogleLikeItem: upstream error');
    return {
      ok: false,
      provider: 'hardcover',
      statusCode: 502,
      message: 'Failed to fetch metadata from Hardcover.',
    };
  }
}

/**
 * Fetch the top metadata item for a query using the *default* provider.
 * Returns a Google-Books-shaped `item` so downstream import/create code is uniform.
 */
export async function fetchTopMetadataItemByDefaultProvider(opts: {
  query: string;
}): Promise<FetchTopMetadataResult> {
  const q = (opts.query ?? '').toString().trim();
  if (!q) {
    return {
      ok: false,
      provider: 'googleBooks',
      statusCode: 400,
      message: 'Missing search query.',
    };
  }

  const provider = await getDefaultMetadataProvider();

  if (provider === 'hardcover') {
    return await fetchTopHardcoverAsGoogleLikeItem(q);
  }

  return await fetchTopGoogleBookItem(q);
}
