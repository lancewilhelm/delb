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
const collectionsStore = useCollectionsStore();

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type SeriesListResponse = {
  data?: {
    series?: Array<{
      id: string;
      name: string;
      bookCount: number;
      books?: Array<{
        id: string;
        title: string;
        seriesIndex: number | null;
        coverThumbnailUrl: string | null;
      }>;
    }>;
  };
};

const errorMessage = ref<string | null>(null);

// ------------------------------
// Series view
// ------------------------------
type SeriesRow = {
  id: string;
  name: string;
  bookCount: number;
  books?: Array<{
    id: string;
    title: string;
    seriesIndex: number | null;
    coverThumbnailUrl: string | null;
  }>;
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

    // Keep client-side sort stable/predictable (server may already sort).
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

const userSettingsStore = useUserSettingsStore();
const maxSeriesCovers = userSettingsStore.settingRef<number>(
  'coverStyle.seriesMaxCovers',
);

// ------------------------------
// UI helpers
// ------------------------------
watch(
  () => collectionsStore.activeSelection,
  async () => {
    await refreshActiveView();
  },
  { deep: true },
);

async function refreshActiveView() {
  // Ensure collections are loaded so collection-scoped queries are valid after navigation.
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }

  await refreshSeries();
}

onMounted(async () => {
  await refreshActiveView();
});

const router = useRouter();
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" @book-uploaded="console.log('book uploaded')" />

    <div class="flex w-full h-full overflow-hidden">
      <!-- Main content (fixed header + scrollable content area) -->
      <div class="flex-1 overflow-hidden flex flex-col min-h-0">
        <!-- Header (non-scrolling): view selector stays fixed -->
        <div class="px-2 shrink-0 border-b border-(--sub-color)">
          <div class="flex items-center justify-between gap-4">
            <!-- View selector (mode) lives here (top-left) -->
            <ViewSelectorDropdown />
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <div class="flex-1 min-h-0 overflow-auto p-4 space-y-6">
            <!-- Filter input -->
            <div class="flex items-center justify-between gap-3z-200">
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

            <div v-else-if="errorMessage" class="text-sm text-(--error-color)">
              {{ errorMessage }}
            </div>

            <div
              v-else-if="filteredSeries.length === 0"
              class="text-sm opacity-80"
            >
              No series found in the selected collection.
            </div>

            <!-- Series content -->
            <div v-else class="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              <!-- Series Cards -->
              <div
                v-for="s in filteredSeries"
                :key="s.id"
                class="flex items-center justify-between gap-3 border border-(--sub-color) hover:border-(--main-color) hover:bg-(--sub-color)/10 rounded-md px-3 py-2 overflow-hidden h-32 cursor-pointer shadow-sm hover:shadow-md"
                @click="router.push(`/series/${s.id}`)"
              >
                <!-- Series info -->
                <div class="min-w-0 z-101">
                  <div class="text-wrap">
                    {{ s.name }}
                  </div>
                  <div class="text-xs opacity-70">
                    {{ s.bookCount }} book{{ s.bookCount === 1 ? '' : 's' }}
                  </div>
                </div>

                <!-- Book covers -->
                <div
                  v-if="
                    (s.books ?? []).some(
                      (b) =>
                        typeof b.coverThumbnailUrl === 'string' &&
                        b.coverThumbnailUrl,
                    )
                  "
                  class="shrink-0 flex items-center h-full"
                >
                  <BookCover
                    v-for="(b, i) in (s.books ?? [])
                      .filter(
                        (x) =>
                          typeof x.coverThumbnailUrl === 'string' &&
                          x.coverThumbnailUrl,
                      )
                      .slice(
                        0,
                        maxSeriesCovers === -1
                          ? s.books?.length
                          : maxSeriesCovers,
                      )"
                    :key="b.id"
                    :src="b.coverThumbnailUrl"
                    :alt="`Cover for ${b.title}`"
                    :title="b.title"
                    class="h-full relative"
                    :class="i === 0 ? '' : '-ml-13'"
                    :style="{ zIndex: 100 - i }"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
