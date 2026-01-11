<script setup lang="ts">
/**
 * Note: Nuxt auto-imports composables/macros like `definePageMeta`, `useHead`, etc.
 * If TypeScript isn't recognizing them (editor/tsserver), restart the dev server
 * and make sure `.nuxt` types are being picked up.
 */
definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
  middleware: [
    async () => {
      const auth = useAuth();
      // Ensure we have a session/user loaded (global auth middleware doesn't enforce roles)
      await auth.fetchSession();
      if (!auth.isAdmin.value) {
        return navigateTo('/', { replace: true });
      }
    },
  ],
});

useHead({
  title: 'Edit Book',
});

interface GoogleBookVolumeInfo {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  industryIdentifiers?: Array<{
    type: string;
    identifier: string;
  }>;
  pageCount?: number;
  categories?: string[];

  // Not a standard Google Books field, but if present from other sources/mapping, we can import it.
  series?: string;
  seriesIndex?: number;

  imageLinks?: {
    smallThumbnail?: string;
    thumbnail?: string;
  };
  language?: string;
}

interface GoogleBookItem {
  id: string;
  volumeInfo: GoogleBookVolumeInfo;
}

interface ImportFields {
  title: boolean;
  authors: boolean;
  description: boolean;
  publisher: boolean;
  published: boolean;
  language: boolean;
  tags: boolean;
  cover: boolean;

  // new: identifiers + series + pages
  identifiers: boolean;
  series: boolean;
  seriesIndex: boolean;
  pages: boolean;
}

interface MetadataImportSelection {
  /**
   * The modal emits a Google-Books-shaped item for both Google Books and Hardcover.
   * For Hardcover, the server proxy already:
   * - filters non-author contributions (e.g. cover artists)
   * - provides tags/genres, identifiers, series, seriesIndex, publishedDate when available
   */
  item: GoogleBookItem;
  fields: ImportFields;
}

function normalizeNameFromExternal(input: string): string {
  return (input ?? '').toString().replace(/\s+/g, ' ').trim();
}

function normalizeIdentifierValue(input: string): string {
  // keep lean: trim and strip spaces/hyphens for isbn values if user pasted formatted
  const v = (input ?? '').toString().trim();
  return v.replace(/[\s-]+/g, '');
}

type BookIdentifierRow = { type: string; value: string };

function normalizeIdentifierType(input: string): string {
  return (input ?? '').toString().trim().toLowerCase();
}

function parseIdentifierRows(input: string): BookIdentifierRow[] {
  const lines = (input ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: BookIdentifierRow[] = [];

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const t = normalizeIdentifierType(line.slice(0, idx));
      const v = normalizeIdentifierValue(line.slice(idx + 1));
      if (t && v) rows.push({ type: t, value: v });
      continue;
    }

    // Allow raw ISBN pasted as a line; treat as unknown type.
    const v = normalizeIdentifierValue(line);
    if (v) rows.push({ type: 'isbn', value: v });
  }

  // De-dupe by (type,value) case-insensitively
  const seen = new Set<string>();
  const out: BookIdentifierRow[] = [];
  for (const r of rows) {
    const k = `${r.type}:${r.value}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function serializeIdentifierRows(rows: BookIdentifierRow[]): string {
  return (rows ?? [])
    .map(
      (r) =>
        `${normalizeIdentifierType(r.type)}:${normalizeIdentifierValue(r.value)}`,
    )
    .filter((x) => x.trim().length > 0)
    .join('\n');
}

function extractIsbnsFromGoogle(item: GoogleBookItem): {
  isbn10?: string;
  isbn13?: string;
} {
  const ids = item.volumeInfo.industryIdentifiers ?? [];
  const isbn13 = ids.find((x) => x.type === 'ISBN_13')?.identifier;
  const isbn10 = ids.find((x) => x.type === 'ISBN_10')?.identifier;

  return {
    isbn10: isbn10 ? normalizeIdentifierValue(isbn10) : undefined,
    isbn13: isbn13 ? normalizeIdentifierValue(isbn13) : undefined,
  };
}

function uniqByLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const cleaned = normalizeNameFromExternal(v);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function normalizeGooglePublishedDateToDateOnlyOrRaw(
  input: string | undefined,
): string | null {
  const v = (input ?? '').trim();
  if (!v) return null;

  // Google Books can return:
  // - "YYYY"
  // - "YYYY-MM"
  // - "YYYY-MM-DD"
  const mDay = v.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (mDay?.[1]) return mDay[1];

  const mMonth = v.match(/^(\d{4})-(\d{2})$/);
  if (mMonth?.[1] && mMonth?.[2]) return `${mMonth[1]}-${mMonth[2]}-01`;

  const mYear = v.match(/^(\d{4})$/);
  if (mYear?.[1]) return `${mYear[1]}-01-01`;

  return v;
}

function getGoogleCoverUrl(item: GoogleBookItem): string | null {
  const raw =
    item.volumeInfo.imageLinks?.thumbnail ||
    item.volumeInfo.imageLinks?.smallThumbnail ||
    null;

  if (!raw) return null;

  // Note: thumbnails often come with `http://` + `&edge=curl`, normalize a bit
  return raw.replace('&edge=curl', '');
}

type Book = {
  id: string;
  title: string;
  coverImagePath?: string | null;
  description?: string | null;
  published?: string | null;
  language?: string | null;

  // New: optional page count coming from API (used by edit form reset logic)
  pages?: number | null;

  // related entities (denormalized by API)
  authors?: { id: string; name: string; position?: number | null }[];
  tags?: { id: string; name: string }[];

  publisher?: { id: string; name: string } | null;
  series?: { id: string; name: string; index?: number | null } | null;

  // new: identifiers (lean v1 UI)
  identifiers?: { type: string; value: string }[];
};

type BookGetResponse = {
  success?: boolean;
  message?: string;
  data?: {
    book?: Book;
    authors?: { id: string; name: string; position?: number | null }[];
  };
};

type GoogleBooksSearchResponse = {
  kind: string;
  totalItems: number;
  items?: GoogleBookItem[];
};

type NameSearchResponse = {
  success?: boolean;
  message?: string;
  data?: {
    results?: { id: string; name: string }[];
  };
};

type NameChip = {
  id?: string; // present when linked to an existing DB row
  name: string;
};

const route = useRoute();
const router = useRouter();

const bookId = computed(() => String(route.params.id || ''));

const loading = ref(false);
const saving = ref(false);
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

const book = ref<Book | null>(null);

const coverResetPending = ref(false);

const coverUrl = computed(() => {
  // If the user has requested a reset, reflect that immediately in the edit UI,
  // but do not persist until Save is pressed.
  if (coverResetPending.value) return null;

  const b = book.value;
  if (!b?.coverImagePath) return null;

  // Stored as: library/<author>/<title>/cover.webp
  // API expects: /api/media/covers/<path under library>
  return `/api/media/covers/${b.coverImagePath.replace(/^library\//, '')}`;
});

// Cover upload UI
const coverFileInput = ref<HTMLInputElement | null>(null);
const selectedCoverFile = ref<File | null>(null);
const coverPreviewUrl = ref<string | null>(null);
const coverUploading = ref(false);

// Cover-from-URL preview (client-side fetch)
const coverUrlInput = ref('');
const coverUrlLoading = ref(false);
let lastCoverUrlAbort: AbortController | null = null;

function pickCoverFile() {
  coverFileInput.value?.click();
}

function revokeCoverPreviewUrl() {
  if (coverPreviewUrl.value) {
    URL.revokeObjectURL(coverPreviewUrl.value);
    coverPreviewUrl.value = null;
  }
}

function onCoverFileChange(e: Event) {
  const input = e.target as HTMLInputElement | null;
  const file = input?.files?.[0] ?? null;

  selectedCoverFile.value = file;

  revokeCoverPreviewUrl();
  coverPreviewUrl.value = file ? URL.createObjectURL(file) : null;
}

function clearSelectedCover() {
  selectedCoverFile.value = null;

  revokeCoverPreviewUrl();

  if (coverFileInput.value) {
    coverFileInput.value.value = '';
  }
}

async function previewCoverFromUrl() {
  const url = coverUrlInput.value.trim();
  if (!url) return;

  if (coverUrlLoading.value) return;

  // Cancel any in-flight fetch
  if (lastCoverUrlAbort) {
    lastCoverUrlAbort.abort();
    lastCoverUrlAbort = null;
  }

  const controller = new AbortController();
  lastCoverUrlAbort = controller;

  coverUrlLoading.value = true;
  errorMessage.value = null;
  successMessage.value = null;

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      setError(text || `Failed to fetch image (${res.status}).`);
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      setError('URL did not return an image.');
      return;
    }

    const blob = await res.blob();

    // Convert to File so existing upload logic works unchanged
    const filenameFromUrl = (() => {
      try {
        const u = new URL(url);
        const base = u.pathname.split('/').filter(Boolean).pop() || '';
        return base || 'cover';
      } catch {
        return 'cover';
      }
    })();

    const file = new File([blob], filenameFromUrl, {
      type: contentType || blob.type || 'image/*',
    });

    selectedCoverFile.value = file;

    revokeCoverPreviewUrl();
    coverPreviewUrl.value = URL.createObjectURL(file);

    setSuccess('Preview loaded. Click Save to apply.');
  } catch (e: unknown) {
    // Ignore abort errors
    if (e instanceof DOMException && e.name === 'AbortError') return;
    setError(e instanceof Error ? e.message : 'Failed to fetch image.');
  } finally {
    coverUrlLoading.value = false;
    lastCoverUrlAbort = null;
  }
}

function resetCoverPreview() {
  // Undo any pending "clear cover" action and revert to the currently-saved cover.
  coverResetPending.value = false;

  // Also drop any pending new cover preview.
  clearSelectedCover();
}

function resetSavedCover() {
  // "Clear cover" should blank the cover in the edit screen until Save is pressed.
  coverResetPending.value = true;

  // If there was a pending new cover, drop it so the UI truly reflects "cleared".
  clearSelectedCover();

  setSuccess('Cover cleared. Click Save to apply.');
}

async function uploadPendingCoverIfAny() {
  if (!book.value?.id) return;
  if (coverUploading.value) return;

  coverUploading.value = true;

  try {
    // If a reset was queued, persist it even if no new cover is selected.
    // This keeps "Reset cover" as a pending edit-screen state until Save is pressed.
    if (coverResetPending.value) {
      const clearRes = await fetch(
        `/api/books/${encodeURIComponent(book.value.id)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            coverImagePath: null,
          }),
        },
      );

      if (!clearRes.ok) {
        const text = await clearRes.text().catch(() => '');
        setError(text || `Failed to reset cover (${clearRes.status}).`);
        throw new Error('Cover reset failed.');
      }

      coverResetPending.value = false;

      // Reload so `coverImagePath` is consistent before applying a new upload.
      await loadBook();
    }

    // If no cover file is selected, we're done (this may have been a reset-only save).
    if (!selectedCoverFile.value) return;

    const fd = new FormData();
    fd.append('file', selectedCoverFile.value);

    const res = await fetch(
      `/api/books/${encodeURIComponent(book.value.id)}/cover`,
      {
        method: 'POST',
        body: fd,
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      setError(text || `Failed to upload cover (${res.status}).`);
      throw new Error('Cover upload failed.');
    }

    clearSelectedCover();

    // Reload the book so `coverImagePath` refreshes
    await loadBook();
  } finally {
    coverUploading.value = false;
  }
}

onBeforeUnmount(() => {
  if (lastCoverUrlAbort) {
    lastCoverUrlAbort.abort();
    lastCoverUrlAbort = null;
  }

  revokeCoverPreviewUrl();
});

const form = reactive({
  title: '',
  description: '',
  published: '', // date-only (YYYY-MM-DD)
  language: '',

  // New: page count (optional)
  pages: '' as string, // keep as string for input; normalized on save

  // Chip editors store names in the UI; server resolves/creates and links.
  publisher: '' as string,
  series: '' as string,
  seriesIndex: '' as string, // keep as string for input

  // new: identifiers (lean v1)
  identifiers: '' as string, // serialized list (one per line) of type:value
});

const identifierTypeInput = ref('');
const identifierValueInput = ref('');

// Authors (chips + typeahead)
const authorInput = ref('');
const authorChips = ref<NameChip[]>([]);
const authorSuggestions = ref<{ id: string; name: string }[]>([]);
const authorSuggestOpen = ref(false);
const authorSearching = ref(false);
let authorSearchTimer: ReturnType<typeof setTimeout> | null = null;

const tagInput = ref('');
const tagChips = ref<NameChip[]>([]);
const tagSuggestions = ref<{ id: string; name: string }[]>([]);
const tagSuggestOpen = ref(false);
const tagSearching = ref(false);
let tagSearchTimer: ReturnType<typeof setTimeout> | null = null;

const publisherInput = ref('');
const publisherSuggestions = ref<{ id: string; name: string }[]>([]);
const publisherSuggestOpen = ref(false);
const publisherSearching = ref(false);
const publisherFocused = ref(false);
let publisherSearchTimer: ReturnType<typeof setTimeout> | null = null;

const seriesInput = ref('');
const seriesSuggestions = ref<{ id: string; name: string }[]>([]);
const seriesSuggestOpen = ref(false);
const seriesSearching = ref(false);
const seriesFocused = ref(false);
let seriesSearchTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeName(name: string): string {
  return (name ?? '').toString().replace(/\s+/g, ' ').trim();
}

function splitTokens(input: string): string[] {
  // Split on commas; ignore empties
  return (input ?? '')
    .split(',')
    .map((s) => normalizeName(s))
    .filter((s) => s.length > 0);
}

function formatDateOnly(input: string): string {
  const raw = (input ?? '').toString().trim();
  if (!raw) return '';

  // If server stored an ISO timestamp, strip to YYYY-MM-DD.
  const isoPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoPrefix?.[1]) return isoPrefix[1];

  // If someone typed slashes (YYYY/MM/DD), normalize.
  const slash = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slash) return `${slash[1]}-${slash[2]}-${slash[3]}`;

  // Otherwise leave it as-is (but UI hints encourage YYYY-MM-DD).
  return raw;
}

/**
 * Pure chip helpers (avoid Vue template ref auto-unwrapping issues).
 */
function chipNormalize(name: string): string {
  return normalizeName(name);
}

function chipAdd(chips: NameChip[], name: string): NameChip[] {
  const cleaned = chipNormalize(name);
  if (!cleaned) return chips;

  const exists = chips.some(
    (c) => c.name.toLowerCase() === cleaned.toLowerCase(),
  );
  if (exists) return chips;

  return [...chips, { name: cleaned }];
}

function chipAddFromSuggestion(
  chips: NameChip[],
  suggestion: { id: string; name: string },
): NameChip[] {
  const cleaned = chipNormalize(suggestion.name);
  if (!cleaned) return chips;

  const exists = chips.some((c) => {
    if (c.id && c.id === suggestion.id) return true;
    return c.name.toLowerCase() === cleaned.toLowerCase();
  });
  if (exists) return chips;

  return [...chips, { id: suggestion.id, name: cleaned }];
}

function chipRemove(chips: NameChip[], index: number): NameChip[] {
  if (index < 0 || index >= chips.length) return chips;
  return chips.filter((_, i) => i !== index);
}

function chipCommitFromComma(
  chips: NameChip[],
  input: string,
): { chips: NameChip[]; input: string; committed: boolean } {
  if (!input.includes(',')) return { chips, input, committed: false };

  const tokens = splitTokens(input);
  const endsWithComma = input.trimEnd().endsWith(',');

  if (endsWithComma) {
    let next = chips;
    for (const t of tokens) next = chipAdd(next, t);
    return { chips: next, input: '', committed: true };
  }

  // commit all but last token
  if (tokens.length <= 1) return { chips, input, committed: false };

  let next = chips;
  for (const t of tokens.slice(0, -1)) next = chipAdd(next, t);

  const keep = tokens[tokens.length - 1] ?? '';
  return { chips: next, input: keep, committed: true };
}

function chipCommitOnEnter(
  chips: NameChip[],
  input: string,
): { chips: NameChip[]; input: string; committed: boolean } {
  const tokens = splitTokens(input);
  if (!tokens.length) return { chips, input, committed: false };

  let next = chips;
  for (const t of tokens) next = chipAdd(next, t);

  return { chips: next, input: '', committed: true };
}

async function fetchSuggestions(
  endpoint: string,
  query: string,
  take: number,
): Promise<{ id: string; name: string }[]> {
  const q = normalizeName(query);
  if (!q) return [];

  const res = await fetch(
    `${endpoint}?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(take))}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
  );
  if (!res.ok) return [];

  const json = (await res.json()) as NameSearchResponse;
  return (json?.data?.results ?? []).slice(0, take);
}

async function fetchAuthorSuggestions(query: string) {
  const q = normalizeName(query);
  if (!q) {
    authorSuggestions.value = [];
    authorSuggestOpen.value = false;
    return;
  }

  authorSearching.value = true;
  try {
    const results = await fetchSuggestions('/api/authors/search', q, 5);

    const filtered = results.filter((r) => {
      const nm = normalizeName(r.name).toLowerCase();
      return !authorChips.value.some(
        (c) => (c.id && c.id === r.id) || c.name.toLowerCase() === nm,
      );
    });

    authorSuggestions.value = filtered;
    authorSuggestOpen.value = true;
  } finally {
    authorSearching.value = false;
  }
}

async function fetchTagSuggestions(query: string) {
  const q = normalizeName(query);
  if (!q) {
    tagSuggestions.value = [];
    tagSuggestOpen.value = false;
    return;
  }

  tagSearching.value = true;
  try {
    const results = await fetchSuggestions('/api/tags/search', q, 8);

    const filtered = results.filter((r) => {
      const nm = normalizeName(r.name).toLowerCase();
      return !tagChips.value.some(
        (c) => (c.id && c.id === r.id) || c.name.toLowerCase() === nm,
      );
    });

    tagSuggestions.value = filtered;
    tagSuggestOpen.value = true;
  } finally {
    tagSearching.value = false;
  }
}

async function fetchPublisherSuggestions(query: string) {
  const q = normalizeName(query);
  if (!q) {
    publisherSuggestions.value = [];
    publisherSuggestOpen.value = false;
    return;
  }

  publisherSearching.value = true;
  try {
    const results = await fetchSuggestions('/api/publishers/search', q, 5);
    publisherSuggestions.value = results;
    publisherSuggestOpen.value = true;
  } finally {
    publisherSearching.value = false;
  }
}

async function fetchSeriesSuggestions(query: string) {
  const q = normalizeName(query);
  if (!q) {
    seriesSuggestions.value = [];
    seriesSuggestOpen.value = false;
    return;
  }

  seriesSearching.value = true;
  try {
    const results = await fetchSuggestions('/api/series/search', q, 5);
    seriesSuggestions.value = results;
    seriesSuggestOpen.value = true;
  } finally {
    seriesSearching.value = false;
  }
}

watch(
  () => authorInput.value,
  (v) => {
    const committed = chipCommitFromComma(authorChips.value, v);
    if (committed.committed) {
      authorChips.value = committed.chips;
      authorInput.value = committed.input;
      authorSuggestOpen.value = false;
    }

    // Debounced search for typeahead (only when there is a non-empty token being typed)
    if (authorSearchTimer) {
      clearTimeout(authorSearchTimer);
      authorSearchTimer = null;
    }

    const q = normalizeName(authorInput.value);
    if (!q) {
      authorSuggestions.value = [];
      authorSuggestOpen.value = false;
      return;
    }

    authorSearchTimer = setTimeout(() => {
      fetchAuthorSuggestions(q);
    }, 250);
  },
);

watch(
  () => tagInput.value,
  (v) => {
    const committed = chipCommitFromComma(tagChips.value, v);
    if (committed.committed) {
      tagChips.value = committed.chips;
      tagInput.value = committed.input;
      tagSuggestOpen.value = false;
    }

    if (tagSearchTimer) {
      clearTimeout(tagSearchTimer);
      tagSearchTimer = null;
    }

    const q = normalizeName(tagInput.value);
    if (!q) {
      tagSuggestions.value = [];
      tagSuggestOpen.value = false;
      return;
    }

    tagSearchTimer = setTimeout(() => {
      fetchTagSuggestions(q);
    }, 250);
  },
);

watch(
  () => publisherInput.value,
  (v) => {
    // Only search/show suggestions while the input is actively focused.
    // This prevents the dropdown from opening on initial hydration when the field has a value.
    if (!publisherFocused.value) return;

    if (publisherSearchTimer) {
      clearTimeout(publisherSearchTimer);
      publisherSearchTimer = null;
    }

    const q = normalizeName(v);
    if (!q) {
      publisherSuggestions.value = [];
      publisherSuggestOpen.value = false;
      return;
    }

    publisherSearchTimer = setTimeout(() => {
      fetchPublisherSuggestions(q);
    }, 250);
  },
);

watch(
  () => seriesInput.value,
  (v) => {
    // Only search/show suggestions while the input is actively focused.
    // This prevents the dropdown from opening on initial hydration when the field has a value.
    if (!seriesFocused.value) return;

    if (seriesSearchTimer) {
      clearTimeout(seriesSearchTimer);
      seriesSearchTimer = null;
    }

    const q = normalizeName(v);
    if (!q) {
      seriesSuggestions.value = [];
      seriesSuggestOpen.value = false;
      return;
    }

    seriesSearchTimer = setTimeout(() => {
      fetchSeriesSuggestions(q);
    }, 250);
  },
);

onBeforeUnmount(() => {
  if (authorSearchTimer) {
    clearTimeout(authorSearchTimer);
    authorSearchTimer = null;
  }
  if (tagSearchTimer) {
    clearTimeout(tagSearchTimer);
    tagSearchTimer = null;
  }
  if (publisherSearchTimer) {
    clearTimeout(publisherSearchTimer);
    publisherSearchTimer = null;
  }
  if (seriesSearchTimer) {
    clearTimeout(seriesSearchTimer);
    seriesSearchTimer = null;
  }
});

function setError(msg: string) {
  errorMessage.value = msg;
  successMessage.value = null;
}

function setSuccess(msg: string) {
  successMessage.value = msg;
  errorMessage.value = null;
}

function bookToForm(b: Book) {
  form.title = b.title ?? '';

  // Hydrate author chips from the ordered author list.
  // We keep both `id` and `name` so chips can be linked to DB authors.
  authorChips.value = (b.authors ?? [])
    .slice()
    .sort((a, c) => {
      const aPos = typeof a.position === 'number' ? a.position : 10_000;
      const cPos = typeof c.position === 'number' ? c.position : 10_000;
      return aPos - cPos;
    })
    .map((a) => ({
      id: a.id,
      name: a.name,
    }));

  authorInput.value = '';
  authorSuggestions.value = [];
  authorSuggestOpen.value = false;

  form.description = b.description ?? '';
  form.published = formatDateOnly(b.published ?? '');
  form.language = b.language ?? '';

  // Pages (optional)
  form.pages = typeof b.pages === 'number' ? String(b.pages) : '';

  // Series / publisher are edited by name in the UI.
  form.publisher = b.publisher?.name ?? '';
  form.series = b.series?.name ?? '';
  form.seriesIndex =
    typeof b.series?.index === 'number' && !Number.isNaN(b.series.index)
      ? String(b.series.index)
      : '';

  // Tags (chips)
  tagChips.value = (b.tags ?? []).map((t) => ({ id: t.id, name: t.name }));
  tagInput.value = '';
  tagSuggestions.value = [];
  tagSuggestOpen.value = false;

  // Identifiers (lean v1): render as newline list
  const ids = (b.identifiers ?? [])
    .map((i) => ({ type: i.type, value: i.value }))
    .filter(
      (i) =>
        (i.type ?? '').toString().trim().length > 0 &&
        (i.value ?? '').toString().trim().length > 0,
    );

  form.identifiers = serializeIdentifierRows(ids);

  // Single-value typeaheads
  publisherInput.value = form.publisher;
  seriesInput.value = form.series;
  publisherSuggestions.value = [];
  publisherSuggestOpen.value = false;
  seriesSuggestions.value = [];
  seriesSuggestOpen.value = false;
}

async function loadBook() {
  if (!bookId.value) {
    setError('Missing book id.');
    return;
  }

  loading.value = true;
  errorMessage.value = null;
  successMessage.value = null;

  try {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId.value)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      setError(text || `Failed to load book (${res.status}).`);
      return;
    }

    const json = (await res.json()) as BookGetResponse;
    if (!json?.success || !json.data?.book) {
      setError(json?.message || 'Failed to load book.');
      return;
    }

    // Ensure authors are present on the book object for form hydration.
    const hydratedBook: Book = {
      ...json.data.book,
      authors: (json.data.authors ?? json.data.book.authors ?? []).slice(),
    };

    book.value = hydratedBook;
    bookToForm(hydratedBook);
  } catch (e: unknown) {
    setError(e instanceof Error ? e.message : 'Failed to load book.');
  } finally {
    loading.value = false;
  }
}

function normalizeStringOrNullFromOptional(
  input: string | null | undefined,
): string | null {
  const v = (input ?? '').toString().trim();
  return v.length ? v : null;
}

function normalizeSeriesIndex(input: string): number | null {
  const v = (input ?? '').trim();
  if (!v.length) return null;
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new Error('Series index must be a number.');
  }
  return n;
}

function normalizeDateOnlyOrNull(input: string): string | null {
  const v = formatDateOnly(input);
  if (!v) return null;

  // Enforce date-only display/saves as YYYY-MM-DD when it looks like a date.
  // If it doesn't match, still allow raw (lean v1), but we won't preserve timestamps.
  const m = v.match(/^(\d{4}-\d{2}-\d{2})$/);
  const dateOnly = m?.[1] ?? null;
  return dateOnly ?? v;
}

function normalizePagesOrNull(input: string): number | null {
  const raw = (input ?? '').toString().trim();
  if (!raw) return null;

  // Accept only non-negative integers
  if (!/^\d+$/.test(raw)) return null;

  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;

  return n;
}

async function save() {
  if (!book.value) return;

  saving.value = true;
  errorMessage.value = null;
  successMessage.value = null;

  try {
    // Commit any remaining typed author/tags before saving
    {
      const committed = chipCommitOnEnter(authorChips.value, authorInput.value);
      if (committed.committed) {
        authorChips.value = committed.chips;
        authorInput.value = committed.input;
        authorSuggestOpen.value = false;
      }
    }
    {
      const committed = chipCommitOnEnter(tagChips.value, tagInput.value);
      if (committed.committed) {
        tagChips.value = committed.chips;
        tagInput.value = committed.input;
        tagSuggestOpen.value = false;
      }
    }

    const payload = {
      title: normalizeStringOrNullFromOptional(form.title),
      // send names (server will link/create as needed)
      authors: authorChips.value.map((c) => c.name),
      tags: tagChips.value.map((c) => c.name),

      description: normalizeStringOrNullFromOptional(form.description),
      published: normalizeDateOnlyOrNull(form.published),
      language: normalizeStringOrNullFromOptional(form.language),

      pages: normalizePagesOrNull(form.pages),

      publisherName: normalizeStringOrNullFromOptional(form.publisher),
      seriesName: normalizeStringOrNullFromOptional(form.series),
      seriesIndex: normalizeSeriesIndex(form.seriesIndex),

      // new (server support required): book_identifiers
      identifiers: normalizeStringOrNullFromOptional(form.identifiers),
    };

    // Title is required server-side; keep lean client-side validation
    if (!payload.title) {
      setError('Title is required.');
      return;
    }

    const res = await fetch(`/api/books/${encodeURIComponent(book.value.id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      setError(text || `Failed to save (${res.status}).`);
      return;
    }

    // Upload cover (if a new one is pending) as part of Save.
    await uploadPendingCoverIfAny();

    setSuccess('Saved.');

    // After a successful save, return to the book page
    backToBook();
  } catch (e: unknown) {
    setError(e instanceof Error ? e.message : 'Failed to save.');
  } finally {
    saving.value = false;
  }
}

function resetForm() {
  if (!book.value) return;

  // Global reset should revert ALL pending changes in the edit UI, including cover changes.
  coverResetPending.value = false;
  resetCoverPreview();

  bookToForm(book.value);
}

function backToBook() {
  router.push(`/books/${encodeURIComponent(bookId.value)}`);
}

// Metadata search modal
const metadataSearchOpen = ref(false);
const metadataSearchQuery = computed(() => book.value?.title || '');

/**
 * Auto-fetch (top result) state
 */
const autoFetchingMetadata = ref(false);

function openMetadataSearch() {
  metadataSearchOpen.value = true;
}

function closeMetadataSearch() {
  metadataSearchOpen.value = false;
}

const globalSettingsStore = useGlobalSettingsStore();

async function handleAutoFetchMetadata() {
  if (autoFetchingMetadata.value) return;

  // Use the default provider from global settings, falling back to Google Books.

  errorMessage.value = null;
  successMessage.value = null;

  autoFetchingMetadata.value = true;
  try {
    // Ensure provider choice + capability flags are current
    await globalSettingsStore.pullLatest();
    const provider =
      globalSettingsStore.settings.metadataProvider ?? 'googleBooks';

    const q = (metadataSearchQuery.value || '').trim();
    if (!q) {
      throw new Error('No title available to search.');
    }

    let item: GoogleBookItem | null = null;

    if (provider === 'hardcover') {
      // Use the same server endpoint shape as the modal, then map into a Google-like item.
      const resp = await $fetch<{
        success: boolean;
        data?: {
          results: Array<{
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
          }>;
        };
        message?: string;
      }>('/api/books/metadata/hardcover/search', {
        method: 'GET',
        params: { q },
      });

      const top = resp?.data?.results?.[0];
      if (!top) {
        throw new Error('No results found.');
      }

      // Inline mapping (kept minimal/specific to current server response)
      const categories = Array.isArray(top.genres) ? top.genres : undefined;
      const industryIdentifiers = Array.isArray(top.identifiers)
        ? top.identifiers
            .map((x) => {
              if (!x || x.type !== 'hardcover') return null;
              const v = normalizeIdentifierValue(x.value ?? '');
              if (!v) return null;
              return { type: 'HARDCOVER', identifier: v };
            })
            .filter(
              (x): x is { type: string; identifier: string } => x !== null,
            )
        : undefined;

      item = {
        id: String(top.id ?? ''),
        volumeInfo: {
          title: top.title || undefined,
          authors: Array.isArray(top.authors) ? top.authors : undefined,
          publisher:
            typeof top.publisher === 'string' && top.publisher.trim()
              ? top.publisher.trim()
              : undefined,
          publishedDate:
            typeof top.published === 'string' && top.published.trim()
              ? top.published.trim()
              : undefined,
          description: top.description || undefined,
          industryIdentifiers:
            industryIdentifiers && industryIdentifiers.length
              ? industryIdentifiers
              : undefined,
          categories: categories && categories.length ? categories : undefined,
          series:
            typeof top.series === 'string' && top.series.trim()
              ? top.series.trim()
              : undefined,
          seriesIndex:
            typeof top.seriesIndex === 'number' &&
            !Number.isNaN(top.seriesIndex)
              ? top.seriesIndex
              : undefined,
          pageCount:
            typeof top.pages === 'number' && !Number.isNaN(top.pages)
              ? top.pages
              : undefined,
          imageLinks: top.cover
            ? {
                thumbnail: top.cover,
              }
            : undefined,
          language:
            typeof top.language === 'string' && top.language.trim()
              ? top.language.trim()
              : undefined,
        },
      };
    } else {
      // Default: Google Books
      const response = await $fetch<GoogleBooksSearchResponse>(
        '/api/books/metadata/search',
        {
          method: 'GET',
          params: { q },
        },
      );

      const items = response.items ?? [];
      if (!items.length) {
        throw new Error('No results found.');
      }

      item = items[0] ?? null;
    }

    if (!item) {
      throw new Error('No results found.');
    }

    // Import everything (all fields true) from top hit
    await handleMetadataSelect({
      item,
      fields: {
        title: true,
        authors: true,
        description: true,
        publisher: true,
        published: true,
        language: true,
        tags: true,
        cover: true,
        identifiers: true,
        series: true,
        seriesIndex: true,
        pages: true,
      },
    });
  } catch (e: unknown) {
    setError(e instanceof Error ? e.message : 'Failed to auto-fetch metadata.');
  } finally {
    autoFetchingMetadata.value = false;
  }
}

async function handleMetadataSelect(selection: MetadataImportSelection) {
  // Keep this lean: apply selected fields directly to the edit form / chips.
  // Note: Hardcover results are mapped by the modal into a Google-Books-shaped `item`,
  // so we can treat both sources the same here.
  const item = selection.item;
  const fields = selection.fields;

  try {
    // Title
    if (fields.title && item.volumeInfo.title) {
      form.title = item.volumeInfo.title;
    }

    // Authors (chips by name; server resolves on save)
    // Hardcover proxy filters out non-author contributions (e.g. cover artists) before it reaches here.
    if (fields.authors && item.volumeInfo.authors?.length) {
      const names = uniqByLower(item.volumeInfo.authors);
      authorChips.value = names.map((name) => ({ name }));
      authorInput.value = '';
      authorSuggestions.value = [];
      authorSuggestOpen.value = false;
    }

    // Description
    if (fields.description && item.volumeInfo.description) {
      form.description = item.volumeInfo.description;
    }

    // Publisher (by name; server resolves on save)
    if (fields.publisher && item.volumeInfo.publisher) {
      const nm = normalizeNameFromExternal(item.volumeInfo.publisher);
      form.publisher = nm;
      publisherInput.value = nm;
      publisherSuggestions.value = [];
      publisherSuggestOpen.value = false;
    }

    // Series / Series Index
    // Hardcover mapping can provide these via `volumeInfo.series` / `volumeInfo.seriesIndex`.
    if (fields.series && item.volumeInfo.series) {
      const nm = normalizeNameFromExternal(item.volumeInfo.series);
      form.series = nm;
      seriesInput.value = nm;
      seriesSuggestions.value = [];
      seriesSuggestOpen.value = false;
    }
    if (
      fields.seriesIndex &&
      typeof item.volumeInfo.seriesIndex === 'number' &&
      !Number.isNaN(item.volumeInfo.seriesIndex)
    ) {
      // keep as string for input
      form.seriesIndex = String(item.volumeInfo.seriesIndex);
    }

    // Published (normalize to date-only when possible)
    if (fields.published && item.volumeInfo.publishedDate) {
      const normalized = normalizeGooglePublishedDateToDateOnlyOrRaw(
        item.volumeInfo.publishedDate,
      );
      form.published = normalized ?? '';
    }

    // Language
    if (fields.language && item.volumeInfo.language) {
      form.language = item.volumeInfo.language;
    }

    // Pages
    if (fields.pages && typeof item.volumeInfo.pageCount === 'number') {
      form.pages = String(item.volumeInfo.pageCount);
    }

    // Tags (categories/tags -> tag chips by name; server resolves on save)
    if (fields.tags && item.volumeInfo.categories?.length) {
      const tagsFromCategories = uniqByLower(item.volumeInfo.categories);
      tagChips.value = tagsFromCategories.map((name) => ({ name }));
      tagInput.value = '';
      tagSuggestions.value = [];
      tagSuggestOpen.value = false;
    }

    // Identifiers (supports ISBN + non-ISBN identifiers like Hardcover id)
    if (fields.identifiers) {
      const existing = parseIdentifierRows(form.identifiers);
      const next = [...existing];

      // Google Books ISBNs (when present)
      const { isbn10, isbn13 } = extractIsbnsFromGoogle(item);
      if (isbn13) next.push({ type: 'isbn13', value: isbn13 });
      if (isbn10) next.push({ type: 'isbn10', value: isbn10 });

      // Non-ISBN identifiers:
      // The metadata modal maps provider-specific IDs into `industryIdentifiers` too.
      // For Hardcover, it uses type "HARDCOVER" with the Hardcover book id as the identifier.
      const ids = item.volumeInfo.industryIdentifiers ?? [];
      for (const id of ids) {
        const tRaw = (id?.type ?? '').toString().trim().toLowerCase();
        const vRaw = (id?.identifier ?? '').toString().trim();
        if (!tRaw || !vRaw) continue;

        if (tRaw === 'hardcover') {
          next.push({ type: 'hardcover', value: vRaw });
        }
      }

      form.identifiers = serializeIdentifierRows(next);
    }

    // Cover (preview only — do NOT upload automatically)
    // This matches the "Fetch cover from URL" flow where you can clear/reset before saving.
    if (fields.cover) {
      const coverUrl = getGoogleCoverUrl(item);
      if (!coverUrl) {
        throw new Error('No cover URL available for this result.');
      }

      // Reuse the existing URL preview flow, but stop short of uploading.
      // This will populate `selectedCoverFile` + `coverPreviewUrl` and show the preview.
      errorMessage.value = null;
      successMessage.value = null;

      const proxied = `/api/books/metadata/cover?url=${encodeURIComponent(coverUrl)}`;
      coverUrlInput.value = proxied;

      await previewCoverFromUrl();
    }

    setSuccess('Imported selected fields.');
  } catch (e: unknown) {
    setError(e instanceof Error ? e.message : 'Failed to import metadata.');
  } finally {
    closeMetadataSearch();
  }
}

onMounted(() => {
  loadBook();
});

watch(
  () => bookId.value,
  () => {
    loadBook();
  },
);
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <!-- Header -->
    <AppHeader class="w-full" />

    <!-- Content -->
    <div class="w-full h-full p-4 overflow-auto">
      <div
        class="flex items-center justify-between gap-2 mb-4 text-(--main-color)"
      >
        <!-- Back button -->
        <div
          v-tooltip="'Back to book'"
          type="button"
          class="opacity-80 hover:opacity-100 cursor-pointer"
          @click="backToBook"
        >
          <icon name="lucide:arrow-left" class="text-3xl" />
        </div>

        <!-- Metadata header -->
        <div v-if="book" class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <div class="text-sm opacity-70">
              ID: <span class="font-mono">{{ book.id }}</span>
            </div>
          </div>

          <div class="flex gap-2 shrink-0">
            <button
              class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
              type="button"
              :disabled="saving"
              @click="resetForm"
            >
              Reset
            </button>

            <button
              class="px-3 py-2 rounded-md bg-(--main-color) text-(--bg-color) hover:bg-(--main-color)/90! text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              type="button"
              :disabled="saving"
              @click="save"
            >
              <span v-if="saving">Saving...</span>
              <span v-else>Save</span>
            </button>
          </div>
        </div>
      </div>

      <div v-if="loading" class="text-sm opacity-80">Loading...</div>

      <div v-else-if="errorMessage" class="text-sm text-(--error-color) mb-4">
        {{ errorMessage }}
      </div>

      <div v-else-if="!book" class="text-sm opacity-80">No book loaded.</div>

      <div
        v-else
        class="flex flex-col md:flex-row gap-6 items-start justify-center"
      >
        <!-- Left column: cover preview + upload -->
        <div
          class="flex flex-col justify-center items-center w-full sm:w-80 shrink-0 self-center md:self-start"
        >
          <BookCover
            :src="coverPreviewUrl ?? coverUrl"
            :alt="`Cover for ${book.title}`"
            :title="book.title"
            class="w-50! sm:w-full!"
          />

          <input
            ref="coverFileInput"
            class="hidden"
            type="file"
            accept="image/*"
            @change="onCoverFileChange"
          />

          <div class="flex flex-wrap gap-1 pt-2 justify-center">
            <button
              v-tooltip="'Upload cover from computer'"
              class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
              type="button"
              :disabled="saving || coverUrlLoading"
              @click="pickCoverFile"
            >
              <icon name="lucide:image-up" class="scale-135" />
              Upload
            </button>

            <button
              v-if="selectedCoverFile || coverResetPending"
              v-tooltip="'Reset cover to original'"
              class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2!"
              type="button"
              :disabled="saving"
              @click="resetCoverPreview"
            >
              <icon name="ri:reset-left-line" class="scale-135" />
              Reset
            </button>

            <button
              v-tooltip="'Trash current cover'"
              class="px-3 py-2 rounded-md border border-(--error-color) text-(--error-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed!"
              type="button"
              :disabled="
                saving || coverUploading || coverUrlLoading || !coverUrl
              "
              @click="resetSavedCover"
            >
              <icon name="lucide:trash-2" class="scale-135" />
              Clear
            </button>
          </div>

          <div class="w-full pt-3">
            <div class="text-xs opacity-70 mb-1 text-left">
              Or fetch cover from URL
            </div>
            <div class="flex gap-2">
              <input
                v-model="coverUrlInput"
                class="min-w-0 flex-1 px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm"
                type="url"
                placeholder="https://example.com/cover.jpg"
                :disabled="saving || coverUploading"
                @keydown.enter.prevent="previewCoverFromUrl"
              />
              <button
                class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
                type="button"
                :disabled="
                  saving ||
                  coverUploading ||
                  coverUrlLoading ||
                  !coverUrlInput.trim()
                "
                @click="previewCoverFromUrl"
              >
                <icon
                  :name="
                    coverUrlLoading ? 'lucide:loader-circle' : 'lucide:download'
                  "
                  :class="[coverUrlLoading ? 'animate-spin' : '', 'scale-135']"
                />
                {{ coverUrlLoading ? 'Fetching...' : 'Fetch' }}
              </button>
            </div>

            <div
              v-if="coverUrlInput.trim()"
              class="text-xs opacity-60 mt-1 text-left"
            >
              This only previews until you click Save.
            </div>
          </div>

          <div
            v-if="selectedCoverFile"
            class="text-xs opacity-70 pt-2 text-center break-all"
          >
            Selected: {{ selectedCoverFile.name }}
          </div>

          <div class="text-xs opacity-60 pt-2 text-center">
            Covers are stored as
            <span class="font-mono">cover.webp</span>
            next to the book file.
          </div>
        </div>

        <!-- Right column: metadata fields -->
        <div class="min-w-0 flex flex-col gap-4 grow max-w-3xl">
          <div v-if="successMessage" class="text-sm text-green-600">
            {{ successMessage }}
          </div>

          <!-- Metadata form -->
          <div class="grid gap-4">
            <!-- Title -->
            <div class="grid gap-2">
              <div class="flex items-center gap-1">
                <label
                  class="text-sm opacity-70"
                  :class="
                    form.title.trim() !== (book.title ?? '').trim()
                      ? 'text-(--error-color)'
                      : ''
                  "
                  >Title</label
                >
                <icon
                  v-if="form.title.trim() !== (book.title ?? '').trim()"
                  v-tooltip="'Reset title'"
                  name="ri:reset-left-line"
                  class="text-(--error-color) cursor-pointer text-sm"
                  @click="form.title = (book.title ?? '').trim()"
                />
              </div>
              <input
                v-model="form.title"
                class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                type="text"
                placeholder="Title"
              />
            </div>

            <!-- Authors -->
            <div class="grid gap-2">
              <div class="flex items-center gap-1">
                <label
                  class="text-sm opacity-70"
                  :class="
                    authorChips
                      .map((c) => c.name)
                      .join(', ')
                      .trim() !==
                    (book.authors ?? [])
                      .map((a) => a.name)
                      .join(', ')
                      .trim()
                      ? 'text-(--error-color)'
                      : ''
                  "
                  >Authors</label
                >
                <icon
                  v-if="
                    authorChips
                      .map((c) => c.name)
                      .join(', ')
                      .trim() !==
                    (book.authors ?? [])
                      .map((a) => a.name)
                      .join(', ')
                      .trim()
                  "
                  v-tooltip="'Reset authors'"
                  name="ri:reset-left-line"
                  class="text-(--error-color) cursor-pointer text-sm"
                  @click="
                    authorChips = (book.authors ?? []).map((a) => ({
                      id: a.id,
                      name: a.name,
                    }));
                    authorInput = '';
                    authorSuggestions = [];
                    authorSuggestOpen = false;
                  "
                />
              </div>

              <!-- Selected author chips -->
              <div v-if="authorChips.length" class="flex flex-wrap gap-2">
                <UiChip
                  v-for="(c, i) in authorChips"
                  :key="(c.id ?? c.name) + ':' + i"
                  :label="c.name"
                  @remove="authorChips = chipRemove(authorChips, i)"
                />
              </div>

              <!-- Author input + suggestions -->
              <div class="relative">
                <input
                  v-model="authorInput"
                  class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                  type="text"
                  placeholder="Type an author name… (comma to create chips)"
                  @keydown.enter.prevent="
                    (() => {
                      const committed = chipCommitOnEnter(
                        authorChips,
                        authorInput,
                      );
                      if (committed.committed) {
                        authorChips = committed.chips;
                        authorInput = committed.input;
                        authorSuggestOpen = false;
                      }
                    })()
                  "
                  @keydown.esc="
                    (() => {
                      authorSuggestions = [];
                      authorSuggestOpen = false;
                    })()
                  "
                  @focus="authorSuggestOpen = !!authorSuggestions.length"
                />

                <div
                  v-if="
                    authorSuggestOpen &&
                    (authorSearching || authorSuggestions.length)
                  "
                  class="absolute z-50 mt-1 w-full rounded-md border border-(--sub-color) bg-(--bg-color) shadow-lg overflow-hidden"
                >
                  <div
                    v-if="authorSearching"
                    class="px-3 py-2 text-sm opacity-70"
                  >
                    Searching…
                  </div>

                  <button
                    v-for="s in authorSuggestions"
                    :key="s.id"
                    type="button"
                    class="w-full px-3 py-2 text-left text-sm hover:bg-(--sub-color)/10"
                    @click="
                      authorChips = chipAddFromSuggestion(authorChips, s);
                      authorInput = '';
                      authorSuggestOpen = false;
                    "
                  >
                    {{ s.name }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Description -->
            <div class="grid gap-2">
              <div class="flex items-center gap-1">
                <label
                  class="text-sm opacity-70"
                  :class="
                    form.description.trim() !== (book.description ?? '').trim()
                      ? 'text-(--error-color)'
                      : ''
                  "
                  >Description</label
                >
                <icon
                  v-if="
                    form.description.trim() !== (book.description ?? '').trim()
                  "
                  v-tooltip="'Reset description'"
                  name="ri:reset-left-line"
                  class="text-(--error-color) cursor-pointer text-sm"
                  @click="form.description = (book.description ?? '').trim()"
                />
              </div>
              <textarea
                v-model="form.description"
                class="w-full min-h-32 px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                placeholder="Description (HTML/text allowed; rendering happens on the book page)"
              />
            </div>

            <!-- Series Details -->
            <div class="grid sm:grid-cols-2 gap-4">
              <!-- Series -->
              <div class="grid gap-2">
                <div class="flex items-center gap-1">
                  <label
                    class="text-sm opacity-70"
                    :class="
                      form.series.trim() !== (book.series?.name ?? '').trim()
                        ? 'text-(--error-color)'
                        : ''
                    "
                    >Series</label
                  >
                  <icon
                    v-if="
                      form.series.trim() !== (book.series?.name ?? '').trim()
                    "
                    v-tooltip="'Reset series'"
                    name="ri:reset-left-line"
                    class="text-(--error-color) cursor-pointer text-sm"
                    @click="
                      form.series = (book.series?.name ?? '').trim();
                      seriesInput = form.series;
                    "
                  />
                </div>

                <div class="relative">
                  <input
                    v-model="form.series"
                    class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                    type="text"
                    placeholder="Series name"
                    @input="seriesInput = form.series"
                    @keydown.esc="
                      (() => {
                        seriesSuggestions = [];
                        seriesSuggestOpen = false;
                      })()
                    "
                    @focus="
                      (() => {
                        seriesFocused = true;
                        seriesSuggestOpen = !!seriesSuggestions.length;
                      })()
                    "
                    @blur="
                      (() => {
                        seriesFocused = false;
                        seriesSuggestOpen = false;
                      })()
                    "
                  />

                  <div
                    v-if="
                      seriesSuggestOpen &&
                      (seriesSearching || seriesSuggestions.length)
                    "
                    class="absolute z-50 mt-1 w-full rounded-md border border-(--sub-color) bg-(--bg-color) shadow-lg overflow-hidden"
                  >
                    <div
                      v-if="seriesSearching"
                      class="px-3 py-2 text-sm opacity-70"
                    >
                      Searching…
                    </div>

                    <button
                      v-for="s in seriesSuggestions"
                      :key="s.id"
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm hover:bg-(--sub-color)/10"
                      @click="
                        form.series = s.name;
                        seriesInput = s.name;
                        seriesSuggestOpen = false;
                      "
                    >
                      {{ s.name }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- Series Index -->
              <div class="grid gap-2">
                <div class="flex items-center gap-1">
                  <label
                    class="text-sm opacity-70"
                    :class="
                      form.seriesIndex.trim() !==
                      ((book.series?.index ?? '') + '').trim()
                        ? 'text-(--error-color)'
                        : ''
                    "
                  >
                    Series Index
                    <span class="opacity-60">(number)</span>
                  </label>
                  <icon
                    v-if="
                      form.seriesIndex.trim() !==
                      ((book.series?.index ?? '') + '').trim()
                    "
                    v-tooltip="'Reset series index'"
                    name="ri:reset-left-line"
                    class="text-(--error-color) cursor-pointer text-sm"
                    @click="
                      form.seriesIndex = (
                        (book.series?.index ?? '') + ''
                      ).trim()
                    "
                  />
                </div>
                <input
                  v-model="form.seriesIndex"
                  class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                  type="text"
                  inputmode="decimal"
                  placeholder="(blank to clear)"
                />
              </div>
            </div>

            <!-- Tags -->
            <div class="grid gap-2">
              <div class="flex items-center gap-1">
                <label
                  class="text-sm opacity-70"
                  :class="
                    tagChips
                      .map((c) => c.name)
                      .join(', ')
                      .trim() !==
                    (book.tags ?? [])
                      .map((t) => t.name)
                      .join(', ')
                      .trim()
                      ? 'text-(--error-color)'
                      : ''
                  "
                  >Tags</label
                >
                <icon
                  v-if="
                    tagChips
                      .map((c) => c.name)
                      .join(', ')
                      .trim() !==
                    (book.tags ?? [])
                      .map((t) => t.name)
                      .join(', ')
                      .trim()
                  "
                  v-tooltip="'Reset tags'"
                  name="ri:reset-left-line"
                  class="text-(--error-color) cursor-pointer text-sm"
                  @click="
                    tagChips = (book.tags ?? []).map((t) => ({
                      id: t.id,
                      name: t.name,
                    }));
                    tagInput = '';
                    tagSuggestions = [];
                    tagSuggestOpen = false;
                  "
                />
              </div>

              <!-- Selected tag chips -->
              <div v-if="tagChips.length" class="flex flex-wrap gap-2">
                <UiChip
                  v-for="(c, i) in tagChips"
                  :key="(c.id ?? c.name) + ':' + i"
                  :label="c.name"
                  @remove="tagChips = chipRemove(tagChips, i)"
                />
              </div>

              <!-- Tag input + suggestions -->
              <div class="relative">
                <input
                  v-model="tagInput"
                  class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                  type="text"
                  placeholder="Type tags… (comma to create chips)"
                  @keydown.enter.prevent="
                    (() => {
                      const committed = chipCommitOnEnter(tagChips, tagInput);
                      if (committed.committed) {
                        tagChips = committed.chips;
                        tagInput = committed.input;
                        tagSuggestOpen = false;
                      }
                    })()
                  "
                  @keydown.esc="
                    (() => {
                      tagSuggestions = [];
                      tagSuggestOpen = false;
                    })()
                  "
                  @focus="tagSuggestOpen = !!tagSuggestions.length"
                />

                <div
                  v-if="
                    tagSuggestOpen && (tagSearching || tagSuggestions.length)
                  "
                  class="absolute z-50 mt-1 w-full rounded-md border border-(--sub-color) bg-(--bg-color) shadow-lg overflow-hidden"
                >
                  <div v-if="tagSearching" class="px-3 py-2 text-sm opacity-70">
                    Searching…
                  </div>

                  <button
                    v-for="s in tagSuggestions"
                    :key="s.id"
                    type="button"
                    class="w-full px-3 py-2 text-left text-sm hover:bg-(--sub-color)/10"
                    @click="
                      tagChips = chipAddFromSuggestion(tagChips, s);
                      tagInput = '';
                      tagSuggestOpen = false;
                    "
                  >
                    {{ s.name }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Publishing details -->
            <div class="grid sm:grid-cols-2 gap-4">
              <!-- Publisher -->
              <div class="grid gap-2">
                <div class="flex items-center gap-1">
                  <label
                    class="text-sm opacity-70"
                    :class="
                      form.publisher.trim() !==
                      (book.publisher?.name ?? '').trim()
                        ? 'text-(--error-color)'
                        : ''
                    "
                    >Publisher</label
                  >
                  <icon
                    v-if="
                      form.publisher.trim() !==
                      (book.publisher?.name ?? '').trim()
                    "
                    v-tooltip="'Reset publisher'"
                    name="ri:reset-left-line"
                    class="text-(--error-color) cursor-pointer text-sm"
                    @click="
                      form.publisher = (book.publisher?.name ?? '').trim();
                      publisherInput = form.publisher;
                    "
                  />
                </div>

                <div class="relative">
                  <input
                    v-model="form.publisher"
                    class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                    type="text"
                    placeholder="Publisher name"
                    @input="publisherInput = form.publisher"
                    @keydown.esc="
                      (() => {
                        publisherSuggestions = [];
                        publisherSuggestOpen = false;
                      })()
                    "
                    @focus="
                      (() => {
                        publisherFocused = true;
                        publisherSuggestOpen = !!publisherSuggestions.length;
                      })()
                    "
                    @blur="
                      (() => {
                        publisherFocused = false;
                        publisherSuggestOpen = false;
                      })()
                    "
                  />

                  <div
                    v-if="
                      publisherSuggestOpen &&
                      (publisherSearching || publisherSuggestions.length)
                    "
                    class="absolute z-50 mt-1 w-full rounded-md border border-(--sub-color) bg-(--bg-color) shadow-lg overflow-hidden"
                  >
                    <div
                      v-if="publisherSearching"
                      class="px-3 py-2 text-sm opacity-70"
                    >
                      Searching…
                    </div>

                    <button
                      v-for="s in publisherSuggestions"
                      :key="s.id"
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm hover:bg-(--sub-color)/10"
                      @click="
                        form.publisher = s.name;
                        publisherInput = s.name;
                        publisherSuggestOpen = false;
                      "
                    >
                      {{ s.name }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- Published -->
              <div class="grid gap-2">
                <div class="flex items-center gap-1">
                  <label
                    class="text-sm opacity-70"
                    :class="
                      form.published.trim() !==
                      (formatDateOnly(book.published ?? '') || '').trim()
                        ? 'text-(--error-color)'
                        : ''
                    "
                    >Published</label
                  >
                  <icon
                    v-if="
                      form.published.trim() !==
                      (formatDateOnly(book.published ?? '') || '').trim()
                    "
                    v-tooltip="'Reset published date'"
                    name="ri:reset-left-line"
                    class="text-(--error-color) cursor-pointer text-sm"
                    @click="
                      form.published = (
                        formatDateOnly(book.published ?? '') || ''
                      ).trim()
                    "
                  />
                </div>
                <input
                  v-model="form.published"
                  class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                  type="date"
                  placeholder="YYYY-MM-DD"
                />
              </div>
            </div>

            <!-- Identifiers (structured editor) -->
            <div class="grid gap-2">
              <div class="flex items-center gap-1">
                <label
                  class="text-sm opacity-70"
                  :class="
                    form.identifiers.trim() !==
                    (
                      serializeIdentifierRows(book.identifiers ?? []) || ''
                    ).trim()
                      ? 'text-(--error-color)'
                      : ''
                  "
                  >Identifiers</label
                >
                <icon
                  v-if="
                    form.identifiers.trim() !==
                    (
                      serializeIdentifierRows(book.identifiers ?? []) || ''
                    ).trim()
                  "
                  v-tooltip="'Reset identifiers'"
                  name="ri:reset-left-line"
                  class="text-(--error-color) cursor-pointer text-sm"
                  @click="
                    form.identifiers = (
                      serializeIdentifierRows(book.identifiers ?? []) || ''
                    ).trim();
                    identifierTypeInput = '';
                    identifierValueInput = '';
                  "
                />
              </div>

              <div
                v-if="parseIdentifierRows(form.identifiers).length"
                class="grid gap-2"
              >
                <div
                  v-for="(row, idx) in parseIdentifierRows(form.identifiers)"
                  :key="row.type + ':' + row.value + ':' + idx"
                  class="flex items-center gap-2"
                >
                  <div
                    class="px-2 py-1 rounded border border-(--sub-color) text-xs font-mono opacity-80"
                  >
                    {{ row.type }}
                  </div>
                  <div
                    class="flex-1 min-w-0 px-2 py-1 rounded border border-(--sub-color) text-xs font-mono opacity-90 truncate"
                  >
                    {{ row.value }}
                  </div>
                  <button
                    type="button"
                    class="px-2 py-1 rounded border border-(--sub-color) hover:bg-(--sub-color)/10 text-xs"
                    title="Remove"
                    @click="
                      (() => {
                        const rows = parseIdentifierRows(form.identifiers);
                        rows.splice(idx, 1);
                        form.identifiers = serializeIdentifierRows(rows);
                      })()
                    "
                  >
                    <icon name="lucide:x" class="scale-110" />
                  </button>
                </div>
              </div>

              <div class="flex gap-2">
                <input
                  v-model="identifierTypeInput"
                  class="w-28 px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm font-mono"
                  type="text"
                  placeholder="type"
                />
                <input
                  v-model="identifierValueInput"
                  class="flex-1 min-w-0 px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm font-mono"
                  type="text"
                  placeholder="value"
                  @keydown.enter.prevent="
                    (() => {
                      const t = normalizeIdentifierType(identifierTypeInput);
                      const v = normalizeIdentifierValue(identifierValueInput);
                      if (!t || !v) return;
                      const rows = parseIdentifierRows(form.identifiers);
                      rows.push({ type: t, value: v });
                      form.identifiers = serializeIdentifierRows(rows);
                      identifierValueInput = '';
                    })()
                  "
                />
                <button
                  type="button"
                  class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
                  @click="
                    (() => {
                      const t = normalizeIdentifierType(identifierTypeInput);
                      const v = normalizeIdentifierValue(identifierValueInput);
                      if (!t || !v) return;
                      const rows = parseIdentifierRows(form.identifiers);
                      rows.push({ type: t, value: v });
                      form.identifiers = serializeIdentifierRows(rows);
                      identifierValueInput = '';
                    })()
                  "
                >
                  Add
                </button>
              </div>
            </div>

            <!-- Pages -->
            <div class="grid gap-2">
              <div class="flex items-center gap-1">
                <label
                  class="text-sm opacity-70"
                  :class="
                    form.pages.trim() !== ((book.pages ?? '') + '').trim()
                      ? 'text-(--error-color)'
                      : ''
                  "
                  >Pages</label
                >
                <icon
                  v-if="form.pages.trim() !== ((book.pages ?? '') + '').trim()"
                  v-tooltip="'Reset pages'"
                  name="ri:reset-left-line"
                  class="text-(--error-color) cursor-pointer text-sm"
                  @click="form.pages = ((book.pages ?? '') + '').trim()"
                />
              </div>
              <input
                :value="form.pages"
                class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                placeholder="e.g. 465"
                @input="
                  (() => {
                    const el = $event.target as HTMLInputElement | null;
                    if (!el) return;

                    // Keep pages as a string in `form`, but only allow digits.
                    // This avoids Vue/DOM number-input quirks where v-model may not update as expected.
                    const next = (el.value ?? '').replace(/[^\d]/g, '');
                    form.pages = next;
                  })()
                "
              />
            </div>

            <!-- Language -->
            <div class="grid gap-2">
              <div class="flex items-center gap-1">
                <label
                  class="text-sm opacity-70"
                  :class="
                    form.language.trim() !== (book.language ?? '').trim()
                      ? 'text-(--error-color)'
                      : ''
                  "
                  >Language</label
                >
                <icon
                  v-if="form.language.trim() !== (book.language ?? '').trim()"
                  v-tooltip="'Reset language'"
                  name="ri:reset-left-line"
                  class="text-(--error-color) cursor-pointer text-sm"
                  @click="form.language = (book.language ?? '').trim()"
                />
              </div>
              <input
                v-model="form.language"
                class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
                type="text"
                placeholder="e.g. en"
              />
            </div>

            <!-- Metadata Search Buttons -->
            <div class="flex gap-2">
              <!-- Metadata Search Button -->
              <button
                type="button"
                class="w-full border border-(--sub-color) p-2 gap-2"
                @click="openMetadataSearch"
              >
                <Icon name="lucide:search" class="text-xl" />
                <span>Search for Metadata</span>
              </button>

              <!-- Auto-feetch Metadata Button -->
              <button
                type="button"
                class="w-full border border-(--sub-color) p-2 gap-2 flex-col"
                :disabled="autoFetchingMetadata"
                @click="handleAutoFetchMetadata"
              >
                <div class="flex items-center gap-2">
                  <Icon name="lucide:dices" class="text-xl" />
                  <span>{{
                    autoFetchingMetadata ? 'Auto-fetching…' : 'Auto-fetch'
                  }}</span>
                </div>
                <span class="flex gap-1 text-xs opacity-70"
                  >From
                  {{ globalSettingsStore.settings.metadataProvider }}
                  (default)</span
                >
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Metadata Search Modal -->
    <BookMetadataSearchModal
      :open="metadataSearchOpen"
      :initial-query="metadataSearchQuery"
      @close="closeMetadataSearch"
      @select="handleMetadataSelect"
    />
  </div>
</template>
