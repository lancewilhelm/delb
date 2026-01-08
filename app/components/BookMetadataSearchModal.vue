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
}

interface ImportSelection {
  item: GoogleBookItem;
  fields: ImportFields;
}

const props = defineProps<{
  open: boolean;
  initialQuery?: string;
}>();

const emit = defineEmits<{
  close: [];
  select: [selection: ImportSelection];
}>();

const searchQuery = ref(props.initialQuery || '');
const searching = ref(false);
const searchResults = ref<GoogleBookItem[]>([]);
const errorMessage = ref('');

const selectedFields = ref<Record<string, ImportFields>>({});

// Update search query when initialQuery prop changes
watch(
  () => props.initialQuery,
  (newQuery) => {
    if (newQuery) {
      searchQuery.value = newQuery;
    }
  },
);

// Auto-search when modal opens with an initial query
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen && props.initialQuery && searchResults.value.length === 0) {
      performSearch();
    }
  },
);

async function performSearch() {
  if (!searchQuery.value.trim()) {
    errorMessage.value = 'Please enter a search term';
    return;
  }

  searching.value = true;
  errorMessage.value = '';
  searchResults.value = [];

  try {
    const response = await $fetch<GoogleBooksResponse>(
      '/api/books/metadata/search',
      {
        method: 'GET',
        params: {
          q: searchQuery.value,
        },
      },
    );

    if (response.items && response.items.length > 0) {
      searchResults.value = response.items;
      // Initialize fields for each result
      response.items.forEach((item) => initializeFields(item.id, item));
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

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    performSearch();
  }
}

function initializeFields(itemId: string, _item: GoogleBookItem) {
  selectedFields.value[itemId] = {
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
  };
}

function getFields(itemId: string): ImportFields {
  if (!selectedFields.value[itemId]) {
    selectedFields.value[itemId] = {
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
    };
  }
  return selectedFields.value[itemId];
}

function hasAnyFieldSelected(itemId: string): boolean {
  const fields = getFields(itemId);
  return Object.values(fields).some((selected) => selected);
}

function importMetadata(item: GoogleBookItem) {
  const fields = getFields(item.id);
  const selectedData: ImportSelection = {
    item,
    fields,
  };

  // Emit the selection with field info
  emit('select', selectedData);

  console.log('Importing metadata:', {
    book: item.volumeInfo.title,
    selectedFields: Object.entries(fields)
      .filter(([_, selected]) => selected)
      .map(([field]) => field),
    data: item,
  });
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
}

function clearAllFields(itemId: string) {
  const fields = getFields(itemId);
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
}

function getIndustryIdentifiers(
  item: GoogleBookItem,
): Array<{ type: string; identifier: string }> {
  const ids = item.volumeInfo.industryIdentifiers ?? [];
  return ids
    .map((x) => ({
      type: (x.type ?? '').toString().trim(),
      identifier: (x.identifier ?? '').toString().trim(),
    }))
    .filter((x) => x.type.length > 0 && x.identifier.length > 0);
}

function formatIndustryIdentifiers(item: GoogleBookItem): string {
  const ids = getIndustryIdentifiers(item);

  if (!ids.length) return 'N/A';

  // Prefer ISBNs first, then show any other identifier types.
  const order = new Map<string, number>([
    ['ISBN_13', 1],
    ['ISBN_10', 2],
    ['OTHER', 999],
  ]);

  const sorted = ids.slice().sort((a, b) => {
    const aRank = order.get(a.type) ?? order.get('OTHER')!;
    const bRank = order.get(b.type) ?? order.get('OTHER')!;
    if (aRank !== bRank) return aRank - bRank;
    return (
      a.type.localeCompare(b.type) || a.identifier.localeCompare(b.identifier)
    );
  });

  return sorted.map((x) => `${x.type}: ${x.identifier}`).join(' • ');
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
        class="flex items-center justify-between border-b border-(--sub-color) pb-4"
      >
        <div class="text-xl font-semibold">Search Book Metadata</div>
        <button
          type="button"
          class="p-2 hover:bg-(--sub-color)/10 rounded-md transition-colors"
          @click="emit('close')"
        >
          <Icon name="mdi:close" class="w-5 h-5" />
        </button>
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

      <!-- Error Message -->
      <div v-if="errorMessage" class="text-sm text-(--error-color)">
        {{ errorMessage }}
      </div>

      <!-- Results -->
      <div class="flex-1 overflow-y-auto min-h-50 max-h-125">
        <div v-if="searching" class="flex items-center justify-center py-12">
          <div class="text-sm opacity-70">Searching Google Books...</div>
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
            v-for="item in searchResults"
            :key="item.id"
            class="border border-(--sub-color) rounded-lg p-3"
          >
            <div class="flex gap-3">
              <!-- Thumbnail with Cover Checkbox -->
              <div class="shrink-0 flex flex-col gap-2 items-center">
                <div
                  class="w-40 bg-(--sub-color)/20 rounded flex items-center justify-center overflow-hidden"
                >
                  <BookCover
                    :src="getThumbnail(item)"
                    :title="item.volumeInfo.title"
                  />
                </div>
                <!-- Cover Checkbox -->
                <label
                  v-if="getThumbnail(item)"
                  class="flex items-center gap-2 text-xs cursor-pointer"
                >
                  <input
                    v-model="getFields(item.id).cover"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <span class="opacity-70">Import cover</span>
                </label>
              </div>

              <!-- Details with Inline Checkboxes -->
              <div class="flex-1 min-w-0 space-y-2">
                <!-- Title -->
                <label
                  v-if="item.volumeInfo.title"
                  class="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    v-model="getFields(item.id).title"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div class="flex-1 min-w-0">
                    <div
                      v-tooltip="'Title'"
                      class="text-lg font-semibold truncate"
                    >
                      {{ item.volumeInfo.title }}
                    </div>
                  </div>
                </label>

                <!-- Authors -->
                <label
                  v-if="
                    item.volumeInfo.authors && item.volumeInfo.authors.length
                  "
                  class="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    v-model="getFields(item.id).authors"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm opacity-70 truncate">
                      {{ item.volumeInfo.authors.join(', ') }}
                    </div>
                  </div>
                </label>

                <!-- Publisher and Published Date -->
                <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <!-- Publisher -->
                  <label
                    v-if="item.volumeInfo.publisher"
                    class="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      v-model="getFields(item.id).publisher"
                      type="checkbox"
                      class="peer sr-only"
                    />
                    <span
                      class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                    ></span>
                    <span class="opacity-60">{{
                      item.volumeInfo.publisher
                    }}</span>
                  </label>

                  <!-- Published Date -->
                  <label
                    v-if="item.volumeInfo.publishedDate"
                    class="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      v-model="getFields(item.id).published"
                      type="checkbox"
                      class="peer sr-only"
                    />
                    <span
                      class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                    ></span>
                    <span class="opacity-60">{{
                      item.volumeInfo.publishedDate
                    }}</span>
                  </label>

                  <!-- Language -->
                  <label
                    v-if="item.volumeInfo.language"
                    class="flex items-center gap-1.5 cursor-pointer"
                  >
                    <input
                      v-model="getFields(item.id).language"
                      type="checkbox"
                      class="peer sr-only"
                    />
                    <span
                      class="h-3.5 w-3.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                    ></span>
                    <span class="opacity-60"
                      >Lang: {{ item.volumeInfo.language }}</span
                    >
                  </label>

                  <!-- Series -->
                  <label
                    v-if="item.volumeInfo.series"
                    class="flex items-center gap-1.5 cursor-pointer"
                  >
                    <input
                      v-model="getFields(item.id).series"
                      type="checkbox"
                      class="peer sr-only"
                    />
                    <span
                      class="h-3.5 w-3.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                    ></span>
                    <span class="opacity-60"
                      >Series: {{ item.volumeInfo.series }}</span
                    >
                  </label>

                  <!-- Series Index -->
                  <label
                    v-if="typeof item.volumeInfo.seriesIndex === 'number'"
                    class="flex items-center gap-1.5 cursor-pointer"
                  >
                    <input
                      v-model="getFields(item.id).seriesIndex"
                      type="checkbox"
                      class="peer sr-only"
                    />
                    <span
                      class="h-4 w-4 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                    ></span>
                    <span class="opacity-60"
                      >#{{ item.volumeInfo.seriesIndex }}</span
                    >
                  </label>

                  <!-- Identifiers (industryIdentifiers[]) -->
                  <label
                    v-if="
                      item.volumeInfo.industryIdentifiers &&
                      item.volumeInfo.industryIdentifiers.length
                    "
                    class="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      v-model="getFields(item.id).identifiers"
                      type="checkbox"
                      class="peer sr-only"
                    />
                    <span
                      class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                    ></span>
                    <span class="opacity-60">
                      {{ formatIndustryIdentifiers(item) }}
                    </span>
                  </label>
                  <span v-else class="opacity-60"> Identifiers: N/A </span>
                </div>

                <!-- Categories/Tags -->
                <label
                  v-if="
                    item.volumeInfo.categories &&
                    item.volumeInfo.categories.length
                  "
                  class="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    v-model="getFields(item.id).tags"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div class="flex-1 min-w-0">
                    <div
                      class="text-xs opacity-60 flex items-center gap-2 flex-wrap"
                    >
                      Tags:
                      <span
                        v-for="(tag, index) in item.volumeInfo.categories"
                        :key="index"
                        class="border rounded p-1"
                        >{{ tag }}</span
                      >
                    </div>
                  </div>
                </label>

                <!-- Description -->
                <label
                  v-if="item.volumeInfo.description"
                  class="flex items-start gap-2 cursor-pointer"
                >
                  <input
                    v-model="getFields(item.id).description"
                    type="checkbox"
                    class="peer sr-only"
                  />
                  <span
                    class="h-4 w-4 mt-0.5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer shrink-0"
                  ></span>
                  <div class="flex-1 min-w-0">
                    <div class="text-xs opacity-70">
                      {{ item.volumeInfo.description }}
                    </div>
                  </div>
                </label>

                <!-- Action Buttons -->
                <div class="flex gap-2 mt-3 ml-6">
                  <button
                    type="button"
                    class="flex-1 px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-xs transition"
                    @click="selectAllFields(item.id, item)"
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    class="flex-1 px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-xs transition"
                    @click="clearAllFields(item.id)"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    class="flex-4 px-4 py-2 rounded-md bg-(--main-color) text-(--bg-color) hover:opacity-90 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition"
                    :disabled="!hasAnyFieldSelected(item.id)"
                    @click="importMetadata(item)"
                  >
                    Import Selected Fields
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="text-xs opacity-60 text-center pt-2 border-t border-(--sub-color)"
      >
        Powered by Google Books API
      </div>
    </div>
  </ModalWindow>
</template>
