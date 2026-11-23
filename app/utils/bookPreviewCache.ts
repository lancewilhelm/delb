export type CachedUserBookStatus = 'to_be_read' | 'reading' | 'finished' | 'dnf';

export type CachedBookAuthor = { id: string; name: string };
export type CachedBookTag = { id: string; name: string };
export type CachedBookFile = { id: string; format: string; relativePath: string };
export type CachedBookIdentifier = { type: string; value: string };

export type CachedBookDetail = {
  id: string;
  title: string;
  coverImagePath?: string | null;
  spineRevision?: string | null;
  updatedAt?: string | number | Date;
  createdByUserId?: string | null;
  canEdit?: boolean;
  hasPhysicalCopy?: boolean;
  hasAudiobookCopy?: boolean;
  userRating?: number | null;
  userStatus?: CachedUserBookStatus | null;
  userStatusStartedAt?: string | number | Date | null;
  userStatusFinishedAt?: string | number | Date | null;
  userStatusDnfAt?: string | number | Date | null;
  userStatusTbrRank?: number | null;
  userProgressSyncEnabled?: boolean | null;
  authors?: CachedBookAuthor[];
  tags?: CachedBookTag[];
  publisher?: { id: string; name: string } | null;
  series?: { id: string; name: string; index?: number | null } | null;
  identifiers?: CachedBookIdentifier[];
  files?: CachedBookFile[];
  description?: string | null;
  published?: string | null;
  language?: string | null;
  pages?: number | null;
  createdAt: string | number | Date;
};

export type BookPreviewInput = {
  id: string;
  title: string;
  coverImagePath?: string | null;
  spineRevision?: string | null;
  updatedAt?: string | number | Date | null;
  createdAt?: string | number | Date | null;
  authors?: CachedBookAuthor[];
  authorNames?: string[];
  author?: string | null;
  series?: { id: string; name: string; index?: number | null } | null;
  seriesIndex?: number | null;
  publisher?: { id: string; name: string } | null;
  tags?: CachedBookTag[];
  pages?: number | null;
  published?: string | null;
  language?: string | null;
  description?: string | null;
  hasPhysicalCopy?: boolean;
  hasAudiobookCopy?: boolean;
  status?: string | null;
  userStatus?: string | null;
  userRating?: number | null;
};

type BookDetailApiResponse = {
  data?: {
    book?: CachedBookDetail;
    authors?: { id: string; name: string; position?: number | null }[];
    files?: {
      id: string;
      bookId?: string;
      format: string;
      relativePath: string;
    }[];
  };
  success?: boolean;
  message?: string;
};

const MAX_PREVIEWS = 250;
const MAX_DETAILS = 40;
const DETAIL_TTL_MS = 15_000;
const DEFAULT_PREFETCH_DELAY_MS = 80;

const previewCache = new Map<string, CachedBookDetail>();
const detailCache = new Map<
  string,
  { book: CachedBookDetail; cachedAt: number }
>();
const inFlightDetails = new Map<string, Promise<CachedBookDetail | null>>();
const prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function touchLru<V>(map: Map<string, V>, key: string, value: V, maxSize: number) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function toUserBookStatus(
  value?: string | null,
): CachedUserBookStatus | null {
  switch (value) {
    case 'to_be_read':
    case 'reading':
    case 'finished':
    case 'dnf':
      return value;
    default:
      return null;
  }
}

function normalizePreview(input: BookPreviewInput): CachedBookDetail | null {
  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  if (!id || id === '__row-sizer__') return null;

  let authors = input.authors;
  if ((!authors || authors.length === 0) && input.authorNames?.length) {
    authors = input.authorNames
      .filter((name) => Boolean(name && name.trim()))
      .map((name, idx) => ({ id: `preview-author-${idx}`, name }));
  } else if ((!authors || authors.length === 0) && input.author?.trim()) {
    authors = [{ id: 'preview-author-0', name: input.author.trim() }];
  }

  const series = input.series
    ? {
        id: input.series.id,
        name: input.series.name,
        index: input.series.index ?? input.seriesIndex ?? null,
      }
    : null;

  return {
    id,
    title: input.title || '',
    coverImagePath: input.coverImagePath ?? null,
    spineRevision: input.spineRevision ?? null,
    updatedAt: input.updatedAt ?? undefined,
    createdAt: input.createdAt ?? 0,
    authors,
    series,
    publisher: input.publisher ?? null,
    tags: input.tags,
    pages: input.pages ?? null,
    published: input.published ?? null,
    language: input.language ?? null,
    description: input.description ?? null,
    hasPhysicalCopy: input.hasPhysicalCopy,
    hasAudiobookCopy: input.hasAudiobookCopy,
    userStatus: toUserBookStatus(
      input.userStatus !== undefined ? input.userStatus : input.status,
    ),
    userRating: input.userRating ?? null,
  };
}

function normalizeBookDetailResponse(
  json: BookDetailApiResponse | null,
): CachedBookDetail | null {
  const book = json?.data?.book;
  if (!book) return null;

  const copy: CachedBookDetail = { ...book };
  if (!copy.authors && json?.data?.authors) {
    copy.authors = json.data.authors.map((a) => ({
      id: a.id,
      name: a.name,
    }));
  }
  if (!copy.files && json?.data?.files) {
    copy.files = json.data.files.map((f) => ({
      id: f.id,
      format: f.format,
      relativePath: f.relativePath,
    }));
  }
  return copy;
}

export function primeBookPreviews(books: readonly BookPreviewInput[]) {
  for (const item of books) {
    const normalized = normalizePreview(item);
    if (!normalized) continue;
    touchLru(previewCache, normalized.id, normalized, MAX_PREVIEWS);
  }
}

export function getBookPreview(id: string): CachedBookDetail | null {
  const cached = getCachedBookDetail(id);
  if (cached) return cached;

  const preview = previewCache.get(id);
  if (!preview) return null;
  // Refresh recency and return a shallow clone so callers can safely mutate refs.
  touchLru(previewCache, id, preview, MAX_PREVIEWS);
  return { ...preview };
}

export function getCachedBookDetail(
  id: string,
  now = Date.now(),
): CachedBookDetail | null {
  const entry = detailCache.get(id);
  if (!entry) return null;
  if (now - entry.cachedAt > DETAIL_TTL_MS) {
    detailCache.delete(id);
    return null;
  }
  touchLru(detailCache, id, entry, MAX_DETAILS);
  return { ...entry.book };
}

export async function fetchBookDetail(
  id: string,
  opts: {
    force?: boolean;
    fetcher?: typeof fetch;
  } = {},
): Promise<CachedBookDetail | null> {
  const trimmed = id.trim();
  if (!trimmed) return null;

  if (!opts.force) {
    const fresh = getCachedBookDetail(trimmed);
    if (fresh) return fresh;

    const existing = inFlightDetails.get(trimmed);
    if (existing) {
      const book = await existing;
      return book ? { ...book } : null;
    }
  }

  const doFetch = opts.fetcher ?? globalThis.fetch;
  const promise = (async (): Promise<CachedBookDetail | null> => {
    const res = await doFetch(`/api/books/${encodeURIComponent(trimmed)}`, {
      method: 'GET',
    });
    if (!res.ok) {
      throw new Error(`Failed to load book (${res.status})`);
    }
    const json = (await res
      .json()
      .catch(() => null)) as BookDetailApiResponse | null;
    const normalized = normalizeBookDetailResponse(json);
    if (normalized) {
      touchLru(
        detailCache,
        trimmed,
        { book: normalized, cachedAt: Date.now() },
        MAX_DETAILS,
      );
      touchLru(previewCache, trimmed, normalized, MAX_PREVIEWS);
    }
    return normalized;
  })();

  inFlightDetails.set(trimmed, promise);
  try {
    const result = await promise;
    return result ? { ...result } : null;
  } finally {
    if (inFlightDetails.get(trimmed) === promise) {
      inFlightDetails.delete(trimmed);
    }
  }
}

export function scheduleBookDetailPrefetch(
  id: string,
  delayMs = DEFAULT_PREFETCH_DELAY_MS,
) {
  const trimmed = id.trim();
  if (!trimmed || trimmed === '__row-sizer__') return;
  if (getCachedBookDetail(trimmed) || inFlightDetails.has(trimmed)) return;
  if (prefetchTimers.has(trimmed)) return;

  const timer = setTimeout(() => {
    prefetchTimers.delete(trimmed);
    void fetchBookDetail(trimmed).catch(() => {
      // Prefetch errors are non-fatal; actual navigation will surface errors.
    });
  }, delayMs);

  prefetchTimers.set(trimmed, timer);
}

export function cancelBookDetailPrefetch(id: string) {
  const trimmed = id.trim();
  const timer = prefetchTimers.get(trimmed);
  if (timer !== undefined) {
    clearTimeout(timer);
    prefetchTimers.delete(trimmed);
  }
}

export function invalidateBookDetail(id: string) {
  const trimmed = id.trim();
  if (!trimmed) return;
  cancelBookDetailPrefetch(trimmed);
  detailCache.delete(trimmed);
  previewCache.delete(trimmed);
  inFlightDetails.delete(trimmed);
}

export function clearBookPreviewCache() {
  for (const timer of prefetchTimers.values()) {
    clearTimeout(timer);
  }
  prefetchTimers.clear();
  detailCache.clear();
  previewCache.clear();
  inFlightDetails.clear();
}
