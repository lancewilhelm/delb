<script setup lang="ts">
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

interface GoogleBooksResponse {
  kind: string;
  totalItems: number;
  items?: GoogleBookItem[];
}

type MetadataProviderKey = 'googleBooks' | 'hardcover';

type SearchResultSource = MetadataProviderKey;

type SearchResult = {
  source: SearchResultSource;
  id: string;

  // unified fields used by the UI
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  language?: string;

  /**
   * Used as the "Tags" import source in the UI.
   * For Hardcover, this is mapped from Hardcover `genres` (not `tags`).
   * For Google Books, this is mapped from Google Books `categories`.
   */
  categories?: string[];

  industryIdentifiers?: Array<{ type: string; identifier: string }>;
  imageUrl?: string;

  // passthrough so existing import flow keeps working
  googleItem?: GoogleBookItem;
};

// Hardcover API response (server proxy)
type HardcoverSearchResponse = {
  success: boolean;
  data?: {
    query: string;
    results: Array<{
      id: number | string | null;
      title: string;
      authors: string[];
      cover: string | null;
      description: string;
      hardcover_slug: string;

      /**
       * We want "genres" (canonical) not "tags" (subjective).
       * Server returns `genres` as string[].
       */
      genres?: string[];

      /**
       * Only identifier we import from Hardcover:
       * - type: "hardcover"
       * - value: Hardcover book id
       */
      identifiers?: Array<{ type: 'hardcover'; value: string }>;

      published?: string | null; // date-only if possible
      pages?: number | null;

      series?: string | null;
      seriesIndex?: number | null;

      // May be present in some Hardcover shapes / future query expansions
      publisher?: string | null;
      language?: string | null;
    }>;
  };
  message?: string;
};

function normalizeIdentifierValue(input: string): string {
  // keep lean: trim and strip spaces/hyphens for identifier values if user pasted formatted
  const v = (input ?? '').toString().trim();
  return v.replace(/[\s-]+/g, '');
}

function hardcoverIdentifierToGoogleIndustryIdentifiers(
  ids: Array<{ type: 'hardcover'; value: string }> | undefined,
): Array<{ type: string; identifier: string }> {
  const safe = Array.isArray(ids) ? ids : [];
  const mapped = safe
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      if (x.type !== 'hardcover') return null;

      const v =
        'value' in x && typeof x.value === 'string'
          ? normalizeIdentifierValue(x.value)
          : '';

      if (!v) return null;

      return {
        type: 'HARDCOVER',
        identifier: v,
      };
    })
    .filter((x): x is { type: string; identifier: string } => x !== null);

  return mapped;
}

function hardcoverResultToGoogleLikeItem(
  r: NonNullable<HardcoverSearchResponse['data']>['results'][number],
): GoogleBookItem {
  // Use Hardcover `genres` as Delb tags source (not Hardcover `tags`)
  const categories = Array.isArray(r.genres) ? r.genres : undefined;

  // Only import Hardcover id as an identifier (type=HARDCOVER, value=<id>)
  const industryIdentifiers = hardcoverIdentifierToGoogleIndustryIdentifiers(
    r.identifiers,
  );

  const publishedDate =
    typeof r.published === 'string' && r.published.trim()
      ? r.published.trim()
      : undefined;

  return {
    id: String(r.id ?? ''),
    volumeInfo: {
      title: r.title || undefined,
      authors: Array.isArray(r.authors) ? r.authors : undefined,
      publisher:
        typeof r.publisher === 'string' && r.publisher.trim()
          ? r.publisher.trim()
          : undefined,
      publishedDate,
      description: r.description || undefined,
      industryIdentifiers: industryIdentifiers.length
        ? industryIdentifiers
        : undefined,
      categories: categories && categories.length ? categories : undefined,

      // Not standard Google fields, but we support importing them
      series:
        typeof r.series === 'string' && r.series.trim()
          ? r.series.trim()
          : undefined,
      seriesIndex:
        typeof r.seriesIndex === 'number' && !Number.isNaN(r.seriesIndex)
          ? r.seriesIndex
          : undefined,

      // Pages support: map Hardcover pages -> Google pageCount (so importer can reuse it)
      pageCount:
        typeof r.pages === 'number' && !Number.isNaN(r.pages)
          ? r.pages
          : undefined,

      imageLinks: r.cover
        ? {
            thumbnail: r.cover,
          }
        : undefined,

      language:
        typeof r.language === 'string' && r.language.trim()
          ? r.language.trim()
          : undefined,
    },
  };
}

// Track which fields to import for each result
interface ImportFields {
  title: boolean;
  authors: boolean;
  description: boolean;
  publisher: boolean;
  published: boolean;
  language: boolean;
  tags: boolean;
  cover: boolean;

  // New fields
  identifiers: boolean;
  series: boolean;
  seriesIndex: boolean;
  pages: boolean;
}

interface ImportSelection {
  source: SearchResultSource;
  item: GoogleBookItem;
  fields: ImportFields;
}

const props = defineProps<{
  open: boolean;
  initialQuery?: string;
  mode?: 'fields' | 'full';
}>();

const emit = defineEmits<{
  close: [];
  select: [selection: ImportSelection];
}>();

const fullMode = computed(() => props.mode === 'full');

const userSettingsStore = useUserSettingsStore();
const globalSettingsStore = useGlobalSettingsStore();

const searchQuery = ref(props.initialQuery || '');
const searching = ref(false);
const errorMessage = ref('');

const // unified results for display (could be from multiple providers)
  searchResults = ref<SearchResult[]>([]);

const selectedFields = ref<Record<string, ImportFields>>({});

/**
 * Provider toggles:
 * - stored per-user (so state is remembered)
 * - Hardcover toggle should be disabled unless the server reports `hardcoverAvailable`
 */
const providerState = reactive<Record<MetadataProviderKey, boolean>>({
  googleBooks: true,
  hardcover: false,
});

function hydrateProvidersFromUserSettings() {
  const saved = userSettingsStore.activeSettings.metadataSearch?.providers;
  if (Array.isArray(saved) && saved.length) {
    providerState.googleBooks = saved.includes('googleBooks');
    providerState.hardcover = saved.includes('hardcover');
  } else {
    providerState.googleBooks = true;
    providerState.hardcover = false;
  }
}

function ensureProviderValidity() {
  // Hardcover only if server says it's available
  const hardcoverAvailable =
    !!globalSettingsStore.capabilities?.hardcoverAvailable;
  if (!hardcoverAvailable) {
    providerState.hardcover = false;
  }

  // Always keep at least one provider selected
  if (!providerState.googleBooks && !providerState.hardcover) {
    providerState.googleBooks = true;
  }
}

async function persistProvidersToUserSettings() {
  const providers: MetadataProviderKey[] = [
    ...(providerState.googleBooks ? (['googleBooks'] as const) : []),
    ...(providerState.hardcover ? (['hardcover'] as const) : []),
  ];

  await userSettingsStore.updateSettings({
    metadataSearch: {
      providers,
    },
  });
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;

    // Ensure we have latest capability flags (Hardcover availability)
    await globalSettingsStore.pullLatest();

    hydrateProvidersFromUserSettings();
    ensureProviderValidity();

    // Auto-search when modal opens with an initial query
    if (props.initialQuery && searchResults.value.length === 0) {
      performSearch();
    }
  },
);

// Update search query when initialQuery prop changes
watch(
  () => props.initialQuery,
  (newQuery) => {
    if (newQuery) {
      searchQuery.value = newQuery;
    }
  },
);

async function toggleProvider(key: MetadataProviderKey) {
  if (
    key === 'hardcover' &&
    !globalSettingsStore.capabilities?.hardcoverAvailable
  ) {
    return;
  }
  providerState[key] = !providerState[key];
  ensureProviderValidity();
  await persistProvidersToUserSettings();
}

function activeProviders(): MetadataProviderKey[] {
  const providers: MetadataProviderKey[] = [];
  if (providerState.googleBooks) providers.push('googleBooks');
  if (providerState.hardcover) providers.push('hardcover');
  return providers;
}

async function performSearch() {
  if (!searchQuery.value.trim()) {
    errorMessage.value = 'Please enter a search term';
    return;
  }

  searching.value = true;
  errorMessage.value = '';
  searchResults.value = [];

  const providers = activeProviders();

  try {
    const tasks: Promise<SearchResult[]>[] = [];

    if (providers.includes('googleBooks')) {
      tasks.push(searchGoogleBooks(searchQuery.value));
    }

    if (providers.includes('hardcover')) {
      tasks.push(searchHardcover(searchQuery.value));
    }

    const resultsByProvider = await Promise.all(tasks);
    const merged = resultsByProvider.flat();

    if (merged.length > 0) {
      searchResults.value = merged;

      // Initialize fields for each result (now supports both Google and Hardcover)
      merged.forEach((r) => {
        if (r.googleItem) {
          initializeFields(resultKey(r), r.googleItem);
        }
      });
    } else {
      errorMessage.value = 'No results found';
    }
  } catch (error) {
    console.error('Search error:', error);
    errorMessage.value = 'Failed to search. Please try again.';
  } finally {
    searching.value = false;
  }
}

async function searchGoogleBooks(q: string): Promise<SearchResult[]> {
  const response = await $fetch<GoogleBooksResponse>(
    '/api/books/metadata/search',
    {
      method: 'GET',
      params: { q },
    },
  );

  const items = response.items ?? [];
  return items.map((item) => ({
    source: 'googleBooks',
    id: item.id,
    title: item.volumeInfo.title,
    authors: item.volumeInfo.authors,
    publisher: item.volumeInfo.publisher,
    publishedDate: item.volumeInfo.publishedDate,
    description: item.volumeInfo.description,
    language: item.volumeInfo.language,
    categories: item.volumeInfo.categories,
    industryIdentifiers: item.volumeInfo.industryIdentifiers?.map((x) => ({
      type: (x.type ?? '').toString(),
      identifier: (x.identifier ?? '').toString(),
    })),
    imageUrl: getThumbnail(item),
    googleItem: item,
  }));
}

async function searchHardcover(q: string): Promise<SearchResult[]> {
  const resp = await $fetch<HardcoverSearchResponse>(
    '/api/books/metadata/hardcover/search',
    {
      method: 'GET',
      params: { q },
    },
  );

  const items = resp?.data?.results ?? [];
  return items
    .filter((x) => x && x.id !== null)
    .map((x) => {
      const googleLike = hardcoverResultToGoogleLikeItem(x);
      return {
        source: 'hardcover',
        id: String(x.id),
        title: x.title,
        authors: x.authors,
        publisher:
          typeof x.publisher === 'string' && x.publisher.trim()
            ? x.publisher.trim()
            : undefined,
        publishedDate:
          typeof x.published === 'string' && x.published.trim()
            ? x.published.trim()
            : undefined,
        description: x.description,
        language:
          typeof x.language === 'string' && x.language.trim()
            ? x.language.trim()
            : undefined,
        categories: Array.isArray(x.genres) ? x.genres : undefined,
        industryIdentifiers: hardcoverIdentifierToGoogleIndustryIdentifiers(
          x.identifiers,
        ),
        imageUrl: x.cover ?? undefined,
        googleItem: googleLike,
      };
    });
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    performSearch();
  }
}

function resultKey(item: SearchResult): string {
  // stable key for field selection + rendering
  return `${item.source}:${item.id}`;
}

function initializeFields(itemKey: string, item: GoogleBookItem) {
  selectedFields.value[itemKey] = {
    title: !!item.volumeInfo.title,
    authors: !!(item.volumeInfo.authors && item.volumeInfo.authors.length),
    description: !!item.volumeInfo.description,
    publisher: !!item.volumeInfo.publisher,
    published: !!item.volumeInfo.publishedDate,
    language: !!item.volumeInfo.language,
    tags: !!(item.volumeInfo.categories && item.volumeInfo.categories.length),
    cover: !!getThumbnail(item),

    identifiers: !!(
      item.volumeInfo.industryIdentifiers &&
      item.volumeInfo.industryIdentifiers.length
    ),
    series: !!item.volumeInfo.series,
    seriesIndex: typeof item.volumeInfo.seriesIndex === 'number',
    pages: typeof item.volumeInfo.pageCount === 'number',
  };
}

function getFields(itemKey: string): ImportFields {
  if (!selectedFields.value[itemKey]) {
    selectedFields.value[itemKey] = {
      title: false,
      authors: false,
      description: false,
      publisher: false,
      published: false,
      language: false,
      tags: false,
      cover: false,

      identifiers: false,
      series: false,
      seriesIndex: false,
      pages: false,
    };
  }
  return selectedFields.value[itemKey];
}

function hasAnyFieldSelected(itemKey: string): boolean {
  const fields = getFields(itemKey);
  return Object.values(fields).some((selected) => selected);
}

function importMetadata(result: SearchResult) {
  if (!result.googleItem) {
    errorMessage.value = 'No importable data available for this result.';
    return;
  }

  const item = result.googleItem;
  const fields: ImportFields = fullMode.value
    ? {
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
      }
    : getFields(resultKey(result));
  const selectedData: ImportSelection = {
    source: result.source,
    item,
    fields,
  };

  // Emit the selection with field info
  emit('select', selectedData);

  // console.log('Importing metadata:', {
  //   source: result.source,
  //   book: item.volumeInfo.title,
  //   selectedFields: Object.entries(fields)
  //     .filter(([_, selected]) => selected)
  //     .map(([field]) => field),
  //   data: item,
  // });
}

function selectAllFields(itemId: string, item: GoogleBookItem) {
  const fields = getFields(itemId);
  fields.title = !!item.volumeInfo.title;
  fields.authors = !!(
    item.volumeInfo.authors && item.volumeInfo.authors.length
  );
  fields.description = !!item.volumeInfo.description;
  fields.publisher = !!item.volumeInfo.publisher;
  fields.published = !!item.volumeInfo.publishedDate;
  fields.language = !!item.volumeInfo.language;
  fields.tags = !!(
    item.volumeInfo.categories && item.volumeInfo.categories.length
  );
  fields.cover = !!getThumbnail(item);

  fields.identifiers = !!(
    item.volumeInfo.industryIdentifiers &&
    item.volumeInfo.industryIdentifiers.length
  );
  fields.series = !!item.volumeInfo.series;
  fields.seriesIndex = typeof item.volumeInfo.seriesIndex === 'number';
  fields.pages = typeof item.volumeInfo.pageCount === 'number';
}

function clearAllFields(itemKey: string) {
  const fields = getFields(itemKey);
  fields.title = false;
  fields.authors = false;
  fields.description = false;
  fields.publisher = false;
  fields.published = false;
  fields.language = false;
  fields.tags = false;
  fields.cover = false;

  fields.identifiers = false;
  fields.series = false;
  fields.seriesIndex = false;
  fields.pages = false;
}

function getThumbnail(item: GoogleBookItem): string {
  const thumb =
    item.volumeInfo.imageLinks?.thumbnail ||
    item.volumeInfo.imageLinks?.smallThumbnail ||
    '';
  return thumb.replace('&edge=curl', '');
}
</script>

<template>
  <ModalWindow :open="open" :width-full="true" @close="emit('close')">
    <div class="flex flex-col gap-4 w-full!">
      <!-- Header -->
      <div
        class="flex items-center justify-between border-b border-(--sub-color) pb-2"
      >
        <div class="text-xl font-semibold">Search Book Metadata</div>
        <Icon
          name="lucide:x"
          class="text-xl cursor-pointer"
          @click="emit('close')"
        />
      </div>

      <!-- Search Input -->
      <div class="flex gap-2">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search by title, author, ISBN..."
          class="flex-1 px-3 py-2 border border-(--sub-color) rounded-md bg-(--bg-color) text-(--text-color) focus:outline-none focus:border-(--main-color)"
          @keydown="handleKeydown"
        />
        <button
          type="button"
          class="px-4 py-2 bg-(--main-color) text-(--bg-color) rounded-md hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
          :disabled="searching"
          @click="performSearch"
        >
          <span v-if="searching">Searching...</span>
          <span v-else>Search</span>
        </button>
      </div>

      <!-- Provider Toggles -->
      <div class="flex flex-wrap gap-2 -mt-2 items-center">
        <span class="text-sm opacity-70 ml-1">Selected Providers:</span>
        <div
          type="button"
          class="px-3 py-1.5 rounded-md border border-(--sub-color) text-xs transition cursor-pointer"
          :class="
            providerState.googleBooks
              ? 'bg-(--main-color)/50'
              : 'hover:bg-(--main-color)/40'
          "
          @click="toggleProvider('googleBooks')"
        >
          <span class="font-semibold">Google Books</span>
        </div>

        <div
          type="button"
          class="px-3 py-1.5 rounded-md border border-(--sub-color) text-xs transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          :class="
            providerState.hardcover
              ? 'bg-(--main-color)/50'
              : 'hover:bg-(--main-color)/40'
          "
          :disabled="!globalSettingsStore.capabilities?.hardcoverAvailable"
          @click="toggleProvider('hardcover')"
        >
          <span class="font-semibold">Hardcover</span>
          <span
            v-if="!globalSettingsStore.capabilities?.hardcoverAvailable"
            class="opacity-70"
          >
            (not configured)
          </span>
        </div>
      </div>

      <!-- Error Message -->
      <div v-if="errorMessage" class="text-sm text-(--error-color)">
        {{ errorMessage }}
      </div>

      <!-- Results -->
      <div class="flex-1 overflow-y-auto min-h-50 max-h-125">
        <div v-if="searching" class="flex items-center justify-center py-12">
          <div class="text-sm opacity-70">
            Searching {{ activeProviders().join(' + ') }}...
          </div>
        </div>

        <div
          v-else-if="searchResults.length === 0 && !errorMessage"
          class="flex items-center justify-center py-12"
        >
          <div class="text-sm opacity-70">
            Enter a search term to find books
          </div>
        </div>

        <div v-else class="flex flex-col gap-4">
          <div
            v-for="result in searchResults"
            :key="resultKey(result)"
            class="border border-(--sub-color) rounded-lg p-3"
          >
            <template v-if="props.mode === 'full'">
              <div class="flex gap-3">
                <div class="shrink-0 flex flex-col gap-2 items-center">
                  <div
                    class="w-40 bg-(--sub-color)/20 rounded flex items-center justify-center overflow-hidden"
                  >
                    <BookCover
                      :src="result.imageUrl || null"
                      :show-resolution="true"
                      :title="result.title"
                    />
                  </div>

                  <div class="text-[10px] opacity-60">
                    Source: {{ result.source }}
                  </div>
                </div>

                <div class="flex-1 min-w-0 space-y-2">
                  <div class="text-lg font-semibold truncate">
                    {{
                      result.googleItem?.volumeInfo.title ||
                      result.title ||
                      'Untitled'
                    }}
                  </div>

                  <div class="text-sm opacity-80 truncate">
                    {{
                      (result.googleItem?.volumeInfo.authors || result.authors || [])
                        .join(', ') || 'Unknown Author'
                    }}
                  </div>

                  <div
                    v-if="
                      result.googleItem?.volumeInfo.publisher || result.publisher
                    "
                    class="text-xs opacity-70 truncate"
                  >
                    <span class="opacity-60">Publisher:</span>
                    {{
                      result.googleItem?.volumeInfo.publisher ||
                      result.publisher ||
                      '—'
                    }}
                  </div>

                  <div
                    v-if="
                      result.googleItem?.volumeInfo.publishedDate ||
                      result.publishedDate
                    "
                    class="text-xs opacity-70 truncate"
                  >
                    <span class="opacity-60">Published:</span>
                    {{
                      result.googleItem?.volumeInfo.publishedDate ||
                      result.publishedDate ||
                      '—'
                    }}
                  </div>

                  <div
                    v-if="result.googleItem?.volumeInfo.industryIdentifiers?.length"
                    class="text-xs opacity-70"
                  >
                    <span class="opacity-60">Identifiers:</span>
                    <span class="font-mono">
                      {{
                        result.googleItem.volumeInfo.industryIdentifiers
                          .map((x) => `${x.type}:${x.identifier}`)
                          .join(', ')
                      }}
                    </span>
                  </div>

                  <div class="pt-1">
                    <button
                      v-if="result.googleItem"
                      type="button"
                      class="px-4 py-2 rounded-md bg-(--main-color) text-(--bg-color) hover:opacity-90 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition"
                      @click="importMetadata(result)"
                    >
                      Import book
                    </button>
                    <button
                      v-else
                      type="button"
                      class="px-4 py-2 rounded-md border border-(--sub-color) text-sm opacity-60 cursor-not-allowed"
                      disabled
                    >
                      Import not available
                    </button>
                  </div>
                </div>
              </div>
            </template>

            <template v-else>
            <div class="flex gap-3">
              <!-- Thumbnail with Cover Checkbox -->
              <div class="shrink-0 flex flex-col gap-2 items-center">
	                <div
	                  class="w-40 bg-(--sub-color)/20 rounded flex items-center justify-center overflow-hidden"
	                >
	                  <BookCover
	                    :src="result.imageUrl || null"
	                    :show-resolution="true"
	                    :title="result.title"
	                  />
	                </div>

                <!-- Cover Checkbox -->
                <label
                  v-if="result.googleItem && getThumbnail(result.googleItem)"
                  class="flex items-center gap-2 text-xs cursor-pointer"
                >
                  <input
                    v-model="getFields(resultKey(result)).cover"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <span class="opacity-70">Import cover</span>
                </label>

                <div class="text-[10px] opacity-60">
                  Source: {{ result.source }}
                </div>
              </div>

              <!-- Details with Inline Checkboxes -->
              <div class="flex-1 min-w-0 space-y-2">
                <!-- Title -->
                <label
                  v-if="result.googleItem?.volumeInfo.title"
                  class="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    v-model="getFields(resultKey(result)).title"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div class="flex-1 min-w-0">
                    <div class="text-lg font-semibold truncate">
                      <span class="text-xs opacity-70">Title:</span>
                      {{ result.googleItem.volumeInfo.title }}
                    </div>
                  </div>
                </label>

                <div
                  v-else-if="result.title"
                  class="text-lg font-semibold truncate"
                >
                  {{ result.title }}
                </div>

                <!-- Authors -->
                <label
                  v-if="
                    result.googleItem?.volumeInfo.authors &&
                    result.googleItem.volumeInfo.authors.length
                  "
                  class="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    v-model="getFields(resultKey(result)).authors"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm truncate">
                      <span class="text-xs opacity-60">Authors:</span>
                      {{ result.googleItem.volumeInfo.authors.join(', ') }}
                    </div>
                  </div>
                </label>

                <!-- Publisher -->
                <label
                  v-if="result.googleItem?.volumeInfo.publisher"
                  class="flex items-center gap-2 cursor-pointer text-xs"
                >
                  <input
                    v-model="getFields(resultKey(result)).publisher"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div>
                    <span class="opacity-60">Publisher:</span>
                    {{ result.googleItem.volumeInfo.publisher }}
                  </div>
                </label>

                <!-- Published Date -->
                <label
                  v-if="result.googleItem?.volumeInfo.publishedDate"
                  class="flex items-center gap-2 cursor-pointer text-xs"
                >
                  <input
                    v-model="getFields(resultKey(result)).published"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div>
                    <span class="opacity-60">Published:</span>
                    {{ result.googleItem.volumeInfo.publishedDate }}
                  </div>
                </label>

                <div
                  v-else-if="result.authors && result.authors.length"
                  class="text-sm opacity-70 truncate"
                >
                  {{ result.authors.join(', ') }}
                </div>

                <!-- Language -->
                <label
                  v-if="result.googleItem?.volumeInfo.language"
                  class="flex items-center gap-2 cursor-pointer text-xs"
                >
                  <input
                    v-model="getFields(resultKey(result)).language"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div>
                    <span class="opacity-60">Language:</span>
                    {{ result.googleItem.volumeInfo.language }}
                  </div>
                </label>

                <!-- Series & Series Index -->
                <div class="flex gap-2">
                  <!-- Series -->
                  <label
                    v-if="result.googleItem?.volumeInfo.series"
                    class="flex items-center gap-2 cursor-pointer text-xs"
                  >
                    <input
                      v-model="getFields(resultKey(result)).series"
                      type="checkbox"
                      class="peer sr-only"
                    />
                    <span
                      class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                    ></span>
                    <div>
                      <span class="opacity-60">Series:</span>
                      {{ result.googleItem.volumeInfo.series }}
                    </div>
                  </label>

                  <!-- Series Index-->
                  <label
                    v-if="
                      typeof result.googleItem?.volumeInfo.seriesIndex ===
                      'number'
                    "
                    class="flex items-center gap-2 cursor-pointer text-xs"
                  >
                    <input
                      v-model="getFields(resultKey(result)).seriesIndex"
                      type="checkbox"
                      class="peer sr-only"
                    />
                    <span
                      class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                    ></span>
                    <div>
                      <span class="opacity-60">Index:</span> #{{
                        result.googleItem.volumeInfo.seriesIndex
                      }}
                    </div>
                  </label>
                </div>

                <!-- Identifiers (industryIdentifiers[]) -->
                <label
                  v-if="
                    result.googleItem?.volumeInfo.industryIdentifiers &&
                    result.googleItem?.volumeInfo.industryIdentifiers.length
                  "
                  class="flex items-center gap-2 cursor-pointer text-xs"
                >
                  <input
                    v-model="getFields(resultKey(result)).identifiers"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <span class="flex flex-wrap items-center gap-2">
                    <span class="opacity-60"> Identfiers: </span>
                    <span class="flex flex-wrap gap-2">
                      <span
                        v-for="id in result.googleItem.volumeInfo
                          .industryIdentifiers"
                        :key="id.identifier"
                        class="border px-2 py-1 rounded-md"
                      >
                        <span class="border-r pr-1">{{ id.type }}</span>
                        <span class="pl-1">{{ id.identifier }}</span>
                      </span>
                    </span>
                  </span>
                </label>
                <span v-else class="opacity-60 text-xs">
                  Identifiers: N/A
                </span>

                <!-- Pages (pageCount) -->
                <label
                  v-if="
                    typeof result.googleItem?.volumeInfo.pageCount === 'number'
                  "
                  class="flex items-center gap-2 cursor-pointer text-xs"
                >
                  <input
                    v-model="getFields(resultKey(result)).pages"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div>
                    <span class="opacity-60"> Pages:</span>
                    {{ result.googleItem.volumeInfo.pageCount }}
                  </div>
                </label>
                <span v-else class="opacity-60 text-xs"> Pages: N/A </span>

                <!-- Categories/Tags -->
                <label
                  v-if="
                    result.googleItem?.volumeInfo.categories &&
                    result.googleItem.volumeInfo.categories.length
                  "
                  class="flex items-center gap-2 cursor-pointer text-xs"
                >
                  <input
                    v-model="getFields(resultKey(result)).tags"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div class="flex-1 min-w-0">
                    <div class="text-xs flex items-center gap-2">
                      <span class="opacity-60"> Tags: </span>
                      <span class="flex flex-wrap gap-2">
                        <span
                          v-for="(tag, index) in result.googleItem.volumeInfo
                            .categories"
                          :key="index"
                          class="border rounded p-1"
                          >{{ tag }}</span
                        >
                      </span>
                    </div>
                  </div>
                </label>

                <!-- Description -->
                <label
                  v-if="result.googleItem?.volumeInfo.description"
                  class="flex items-start gap-2 cursor-pointer text-xs"
                >
                  <input
                    v-model="getFields(resultKey(result)).description"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div class="flex-1 min-w-0">
                    <div class="flex gap-2">
                      <span class="opacity-60">Description:</span>
                      {{ result.googleItem.volumeInfo.description }}
                    </div>
                  </div>
                </label>

                <div v-else-if="result.description" class="text-xs opacity-70">
                  {{ result.description }}
                </div>

                <!-- Action Buttons -->
                <div class="flex gap-2 mt-3 ml-6">
                  <template v-if="result.googleItem">
                    <button
                      type="button"
                      class="flex-1 px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-xs transition"
                      @click="
                        selectAllFields(resultKey(result), result.googleItem)
                      "
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      class="flex-1 px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-xs transition"
                      @click="clearAllFields(resultKey(result))"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      class="flex-4 px-4 py-2 rounded-md bg-(--main-color) text-(--bg-color) hover:opacity-90 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition"
                      :disabled="!hasAnyFieldSelected(resultKey(result))"
                      @click="importMetadata(result)"
                    >
                      Import Selected Fields
                    </button>
                  </template>

                  <template v-else>
                    <button
                      type="button"
                      class="flex-1 px-3 py-2 rounded-md border border-(--sub-color) text-xs opacity-60 cursor-not-allowed"
                      disabled
                    >
                      Import not available
                    </button>
                  </template>
                </div>
              </div>
            </div>
            </template>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="text-xs opacity-60 text-center pt-2 border-t border-(--sub-color)"
      >
        Select one or more providers above to search.
      </div>
    </div>
  </ModalWindow>
</template>
