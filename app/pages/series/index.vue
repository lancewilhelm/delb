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
const router = useRouter();

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

const seriesQuery = ref('');
const userSettingsStore = useUserSettingsStore();
const maxSeriesCovers = userSettingsStore.settingRef<number>(
  'coverStyle.seriesMaxCovers',
);
const {
  rows: seriesRows,
  hasMore,
  loading: loadingSeries,
  error: errorMessage,
  scrollRoot,
  loadMore,
  retry,
} = useEntityPagination<SeriesRow>({
  inputs: () => ({
    search: seriesQuery.value,
    previewLimit: maxSeriesCovers.value ?? 8,
    collectionId:
      collectionsStore.activeSelection.kind === 'collection'
        ? collectionsStore.activeSelection.collectionId
        : undefined,
  }),
  initialize: async () => {
    if (!collectionsStore.collections.length)
      await collectionsStore.fetchCollections();
  },
  fetchPage: async (query) => {
    const response = await $fetch<{
      data?: { series?: SeriesRow[]; hasMore?: boolean };
    }>('/api/series', { query });
    return {
      rows: response.data?.series ?? [],
      hasMore: response.data?.hasMore ?? false,
    };
  },
  failureMessage: 'Failed to load series',
});
const filteredSeries = seriesRows;
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

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
          <div
            ref="scrollRoot"
            class="flex-1 min-h-0 overflow-auto p-4 space-y-6"
          >
            <!-- Filter input -->
            <div class="flex items-center justify-between gap-3">
              <input
                v-model="seriesQuery"
                class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter series..."
                type="text"
              />
            </div>

            <div
              v-if="loadingSeries && !seriesRows.length"
              class="text-sm opacity-80"
            >
              Loading...
            </div>

            <div
              v-else-if="filteredSeries.length === 0 && !errorMessage"
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
                class="flex items-center justify-between gap-3 border border-(--sub-color) hover:border-(--main-color) hover:bg-(--sub-color)/10 rounded-md px-3 py-2 overflow-hidden min-h-32 cursor-pointer shadow-sm hover:shadow-md"
                @click="router.push(`/series/${s.id}`)"
              >
                <!-- Series info -->
                <div class="min-w-0 flex-1 z-101">
                  <div class="break-words">
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
                  class="ml-auto flex h-28 max-w-[45%] shrink-0 items-center justify-end overflow-hidden"
                >
                  <BookCover
                    v-for="(b, i) in (s.books ?? [])
                      .filter(
                        (x) =>
                          typeof x.coverThumbnailUrl === 'string' &&
                          x.coverThumbnailUrl,
                      )
                      .sort(
                        (a, b) =>
                          (a.seriesIndex ?? 999) - (b.seriesIndex ?? 999),
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
                    class="h-full w-auto! aspect-2/3! shrink-0 relative"
                    :class="i === 0 ? '' : '-ml-13'"
                    :style="{ zIndex: 100 - i }"
                  />
                </div>
              </div>
            </div>
            <EntityPaginationControl
              :root="scrollRoot"
              :row-count="seriesRows.length"
              :has-more="hasMore"
              :loading="loadingSeries"
              :error="errorMessage"
              @load="loadMore"
              @retry="retry"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
