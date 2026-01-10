<script setup lang="ts">
definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
});

// Page metadata
useHead({
  title: 'Home',
});

// Scope (collection) lives in the header collection switcher dropdown.
// View (mode) lives on this page (top-left view selector dropdown).
const uiStore = useUiStore();
const collectionsStore = useCollectionsStore();

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type AuthorsListResponse = {
  data?: {
    authors?: Array<{
      id: string;
      name: string;
      bookCount: number;
    }>;
  };
};

type SeriesListResponse = {
  data?: {
    series?: Array<{
      id: string;
      name: string;
      bookCount: number;
    }>;
  };
};

type PublishersListResponse = {
  data?: {
    publishers?: Array<{
      id: string;
      name: string;
      bookCount: number;
    }>;
  };
};

const seriesHref = (id: string) => `/series/${encodeURIComponent(id)}`;

const errorMessage = ref<string | null>(null);

// Provide a stable collectionId prop for the BooksInfiniteGrid (scroller lives inside component).
const activeCollectionId = computed<string | undefined>(() => {
  if (
    collectionsStore.activeSelection.kind === 'collection' &&
    collectionsStore.activeSelection.collectionId
  ) {
    return collectionsStore.activeSelection.collectionId;
  }
  return undefined;
});

// Books grid error handler (keeps page-level message in sync)
function handleBooksGridError(message: string) {
  errorMessage.value = message;
}

// ------------------------------
// Books sorting
// ------------------------------
type BooksSortOption = {
  id: 'dateAdded' | 'alphabetical' | 'publishedDate';
  label: string;
};

const booksSortOptions: BooksSortOption[] = [
  { id: 'dateAdded', label: 'Date added' },
  { id: 'alphabetical', label: 'Alphabetical' },
  { id: 'publishedDate', label: 'Published date' },
];

const sortOpen = ref(false);
const sortAnchorRef = ref<HTMLElement | null>(null);
const sortPanelRef = ref<HTMLElement | null>(null);

// Direction toggles by re-selecting the active sort option in the dropdown.

const activeBooksSortLabel = computed(() => {
  return (
    booksSortOptions.find((o) => o.id === uiStore.booksSortKey)?.label ??
    'Date added'
  );
});

function closeSortDropdown() {
  sortOpen.value = false;
}

function toggleSortDropdown() {
  sortOpen.value = !sortOpen.value;
}

function selectBooksSort(sortId: BooksSortOption['id']) {
  // Clicking the currently-active sort toggles direction.
  if (uiStore.booksSortKey === sortId) {
    uiStore.toggleBooksSortDirection();
  } else {
    uiStore.setBooksSortKey(sortId);
  }
  closeSortDropdown();
}

function onSortDocumentPointerDown(e: MouseEvent) {
  if (!sortOpen.value) return;
  const target = e.target as Node | null;

  if (
    (sortPanelRef.value && target && sortPanelRef.value.contains(target)) ||
    (sortAnchorRef.value && target && sortAnchorRef.value.contains(target))
  ) {
    return;
  }

  closeSortDropdown();
}

function onSortDocumentKeyDown(e: KeyboardEvent) {
  if (!sortOpen.value) return;
  if (e.key === 'Escape') closeSortDropdown();
}

onMounted(() => {
  document.addEventListener('mousedown', onSortDocumentPointerDown);
  document.addEventListener('keydown', onSortDocumentKeyDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onSortDocumentPointerDown);
  document.removeEventListener('keydown', onSortDocumentKeyDown);
});

// ------------------------------
// Authors view (MVP: aggregated from /api/books)
// ------------------------------
type AuthorRow = {
  id: string;
  name: string;
  bookCount: number;
};

const authors = ref<AuthorRow[]>([]);
const loadingAuthors = ref(false);
const authorQuery = ref('');

const filteredAuthors = computed(() => {
  const q = authorQuery.value.trim().toLowerCase();
  const list = authors.value;
  if (!q) return list;
  return list.filter((a) => a.name.toLowerCase().includes(q));
});

async function refreshAuthors() {
  if (uiStore.libraryView !== 'authors') return;

  loadingAuthors.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    // Use dedicated list endpoint so this view isn't dependent on how many books were loaded.
    const res = await $fetch<AuthorsListResponse>('/api/authors', {
      method: 'GET',
      query,
    });

    const list = res?.data?.authors ?? [];

    // Keep client-side sort stable/predictable (server may already sort).
    authors.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load authors';
    authors.value = [];
  } finally {
    loadingAuthors.value = false;
  }
}

// ------------------------------
// Series view (MVP: aggregated from /api/books)
// ------------------------------
type SeriesRow = {
  id: string;
  name: string;
  bookCount: number;
};

const seriesRows = ref<SeriesRow[]>([]);
const loadingSeries = ref(false);
const seriesQuery = ref('');

const filteredSeries = computed(() => {
  const q = seriesQuery.value.trim().toLowerCase();
  const list = seriesRows.value;
  if (!q) return list;
  return list.filter((s) => s.name.toLowerCase().includes(q));
});

async function refreshSeries() {
  if (uiStore.libraryView !== 'series') return;

  loadingSeries.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    // Use dedicated list endpoint so this view isn't dependent on how many books were loaded.
    const res = await $fetch<SeriesListResponse>('/api/series', {
      method: 'GET',
      query,
    });

    const list = res?.data?.series ?? [];

    seriesRows.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load series';
    seriesRows.value = [];
  } finally {
    loadingSeries.value = false;
  }
}

// ------------------------------
// Publishers view (MVP: aggregated from /api/books)
// ------------------------------
type PublisherRow = {
  id: string;
  name: string;
  bookCount: number;
};

const publishers = ref<PublisherRow[]>([]);
const loadingPublishers = ref(false);
const publisherQuery = ref('');

const filteredPublishers = computed(() => {
  const q = publisherQuery.value.trim().toLowerCase();
  const list = publishers.value;
  if (!q) return list;
  return list.filter((p) => p.name.toLowerCase().includes(q));
});

async function refreshPublishers() {
  if (uiStore.libraryView !== 'publishers') return;

  loadingPublishers.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    // Use dedicated list endpoint so this view isn't dependent on how many books were loaded.
    const res = await $fetch<PublishersListResponse>('/api/publishers', {
      method: 'GET',
      query,
    });

    const list = res?.data?.publishers ?? [];

    publishers.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load publishers';
    publishers.value = [];
  } finally {
    loadingPublishers.value = false;
  }
}

// ------------------------------
// UI helpers
// ------------------------------
// Used to force-recreate the BooksInfiniteGrid (e.g. after upload) so it reloads from page 1.
const booksGridKey = ref(0);

const viewLabel = computed(() => {
  switch (uiStore.libraryView) {
    case 'books':
      return 'Books';
    case 'authors':
      return 'Authors';
    case 'series':
      return 'Series';
    case 'publishers':
      return 'Publishers';
    default:
      return 'Books';
  }
});

// When scope changes, refresh the result set for the active view.
watch(
  () => collectionsStore.activeSelection,
  async () => {
    // When scope changes, refresh the result set for the active view.
    await refreshActiveView();
  },
  { deep: true },
);

// When view changes, fetch only what's needed for that view.
watch(
  () => uiStore.libraryView,
  async (_mode) => {
    errorMessage.value = null;

    // If the user navigated back to Home while collections haven't loaded yet,
    // non-books views can appear empty because the active collection state isn't ready.
    // Ensure collections exist before trying to fetch view data.
    await refreshActiveView();
  },
);

async function refreshActiveView() {
  // Ensure collections are loaded so collection-scoped queries are valid after navigation.
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }

  // Refresh whichever view is currently selected.
  // Books view now uses BooksInfiniteGrid (it owns its own paging/observer).
  if (uiStore.libraryView === 'authors') await refreshAuthors();
  if (uiStore.libraryView === 'series') await refreshSeries();
  if (uiStore.libraryView === 'publishers') await refreshPublishers();
}

const booksSortKey = computed(() => uiStore.booksSortKey);
const booksSortDir = computed(() => uiStore.booksSortDirection);

onMounted(async () => {
  await refreshActiveView();
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" @book-uploaded="booksGridKey++" />

    <div class="flex w-full h-full overflow-hidden">
      <!-- Sidebar = filters (placeholders for now) -->
      <Sidebar class="hidden md:flex w-auto" />

      <!-- Main content (fixed header + scrollable content area) -->
      <div class="flex-1 overflow-hidden flex flex-col min-h-0">
        <!-- Header (non-scrolling): view selector stays fixed -->
        <div class="px-4 py-1 shrink-0 border-b border-(--sub-color)">
          <div class="flex items-end justify-between gap-4">
            <!-- View selector (mode) lives here (top-left) -->
            <ViewSelectorDropdown
              :model-value="uiStore.libraryView"
              @update:model-value="uiStore.setLibraryView"
            />

            <!-- Books sort (only shown in Books view) -->
            <div
              v-if="uiStore.libraryView === 'books'"
              class="flex items-center gap-1 self-center"
            >
              <div class="relative">
                <button
                  ref="sortAnchorRef"
                  class="p-1 flex items-center gap-2"
                  :aria-expanded="sortOpen"
                  aria-haspopup="menu"
                  @click="toggleSortDropdown"
                >
                  <Icon
                    name="lucide:arrow-up-down"
                    class="text-(--main-color) opacity-80 shrink-0"
                  />
                  <span class="text-sm opacity-80">{{
                    activeBooksSortLabel
                  }}</span>
                  <Icon
                    name="lucide:chevron-down"
                    class="text-(--main-color) opacity-80 shrink-0"
                  />
                </button>

                <div
                  v-if="sortOpen"
                  ref="sortPanelRef"
                  class="absolute right-0 mt-1 w-48 border border-(--sub-color) bg-(--bg-color) rounded-md shadow-lg z-50 overflow-hidden"
                  role="menu"
                >
                  <div class="px-3 py-2 border-b border-(--sub-color)">
                    <div class="text-xs opacity-70">Sort</div>
                  </div>

                  <div>
                    <button
                      v-for="o in booksSortOptions"
                      :key="o.id"
                      class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none!"
                      :class="
                        uiStore.booksSortKey === o.id
                          ? 'bg-(--sub-color)/20'
                          : 'hover:bg-(--sub-color)/15'
                      "
                      role="menuitem"
                      @click="selectBooksSort(o.id)"
                    >
                      <span class="truncate text-sm">{{ o.label }}</span>
                      <Icon
                        v-if="uiStore.booksSortKey === o.id"
                        :name="
                          uiStore.booksSortDirection === 'asc'
                            ? 'lucide:arrow-up'
                            : 'lucide:arrow-down'
                        "
                        class="text-(--main-color) opacity-80 shrink-0"
                      />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <!-- Render per-view. -->
          <div
            v-if="uiStore.libraryView === 'books'"
            class="flex flex-col flex-1 min-h-0"
          >
            <!-- Only the books grid scrolls (BooksInfiniteGrid owns the scroller) -->
            <BooksInfiniteGrid
              :key="`${booksGridKey}-${booksSortKey}-${booksSortDir}`"
              :collection-id="activeCollectionId"
              :sort="booksSortKey"
              :sort-dir="booksSortDir"
              class="flex-1 min-h-0"
              @error="handleBooksGridError"
            />
          </div>

          <div v-else class="flex-1 min-h-0 overflow-auto p-4 space-y-6">
            <!-- Authors -->
            <div v-if="uiStore.libraryView === 'authors'">
              <div class="flex items-center justify-between gap-3">
                <div class="text-2xl font-serif text-(--main-color)">
                  Authors
                </div>

                <input
                  v-model="authorQuery"
                  class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                  placeholder="Filter authors..."
                  type="text"
                />
              </div>

              <div v-if="loadingAuthors" class="text-sm opacity-80">
                Loading...
              </div>

              <div v-else-if="errorMessage" class="text-sm text-red-600">
                {{ errorMessage }}
              </div>

              <div
                v-else-if="filteredAuthors.length === 0"
                class="text-sm opacity-80"
              >
                No authors found in the selected collection.
              </div>

              <div v-else class="mt-3 space-y-2">
                <div
                  v-for="a in filteredAuthors"
                  :key="a.id"
                  class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2 overflow-hidden"
                >
                  <div class="min-w-0">
                    <NuxtLink
                      :to="`/authors/${a.id}`"
                      class="truncate hover:underline text-(--main-color)"
                    >
                      {{ a.name }}
                    </NuxtLink>
                    <div class="text-xs opacity-70">
                      {{ a.bookCount }} book{{ a.bookCount === 1 ? '' : 's' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Series -->
            <div v-else-if="uiStore.libraryView === 'series'">
              <div class="flex items-center justify-between gap-3">
                <div class="text-2xl font-serif text-(--main-color)">
                  Series
                </div>

                <input
                  v-model="seriesQuery"
                  class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                  placeholder="Filter series..."
                  type="text"
                />
              </div>

              <div v-if="loadingSeries" class="text-sm opacity-80">
                Loading...
              </div>

              <div v-else-if="errorMessage" class="text-sm text-red-600">
                {{ errorMessage }}
              </div>

              <div
                v-else-if="filteredSeries.length === 0"
                class="text-sm opacity-80"
              >
                No series found in the selected collection.
              </div>

              <div v-else class="mt-3 space-y-2">
                <div
                  v-for="s in filteredSeries"
                  :key="s.id"
                  class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2 overflow-hidden"
                >
                  <div class="min-w-0">
                    <NuxtLink
                      :to="seriesHref(s.id)"
                      class="truncate hover:underline"
                    >
                      {{ s.name }}
                    </NuxtLink>
                    <div class="text-xs opacity-70">
                      {{ s.bookCount }} book{{ s.bookCount === 1 ? '' : 's' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Publishers -->
            <div v-else-if="uiStore.libraryView === 'publishers'">
              <div class="flex items-center justify-between gap-3">
                <div class="text-2xl font-serif text-(--main-color)">
                  Publishers
                </div>

                <input
                  v-model="publisherQuery"
                  class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                  placeholder="Filter publishers..."
                  type="text"
                />
              </div>

              <div v-if="loadingPublishers" class="text-sm opacity-80">
                Loading...
              </div>

              <div v-else-if="errorMessage" class="text-sm text-red-600">
                {{ errorMessage }}
              </div>

              <div
                v-else-if="filteredPublishers.length === 0"
                class="text-sm opacity-80"
              >
                No publishers found in the selected collection.
              </div>

              <div v-else class="mt-3 space-y-2">
                <div
                  v-for="p in filteredPublishers"
                  :key="p.id"
                  class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2 overflow-hidden"
                >
                  <div class="min-w-0">
                    <NuxtLink
                      :to="`/publishers/${p.id}`"
                      class="truncate hover:underline"
                    >
                      {{ p.name }}
                    </NuxtLink>
                    <div class="text-xs opacity-70">
                      {{ p.bookCount }} book{{ p.bookCount === 1 ? '' : 's' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div v-else class="text-sm opacity-80">
              <div class="text-2xl font-serif text-(--main-color)">
                {{ viewLabel }}
              </div>
              <div class="mt-2">Unknown view.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
