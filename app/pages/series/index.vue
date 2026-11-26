<script setup lang="ts">
import { useEntityPagination } from '~/composables/useEntityPagination';
import { useHead } from '~/composables/useHead';
import { useUserSettingsStore } from '~/stores/userSettings';
import { $fetch } from '~/utils/apiFetch';
import {
  browseCardPreviewLimit,
  type BrowseCardRow,
} from '~/utils/browseCards';
import type { CardArtStyle } from '~/utils/dashboardArt';
import { ref } from 'vue';
import AppHeader from '~/components/AppHeader.vue';
import BrowseCardArtSelect from '~/components/BrowseCardArtSelect.vue';
import BrowseCardGrid from '~/components/BrowseCardGrid.vue';
import EntityPaginationControl from '~/components/EntityPaginationControl.vue';
import ViewSelectorDropdown from '~/components/ViewSelectorDropdown.vue';
// Page metadata
useHead({
  title: 'Home',
});

const seriesQuery = ref('');
const userSettingsStore = useUserSettingsStore();
const cardArt = userSettingsStore.settingRef<CardArtStyle>(
  'browseCardArt.series',
);
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
} = useEntityPagination<BrowseCardRow>({
  inputs: () => ({
    search: seriesQuery.value,
    previewLimit: browseCardPreviewLimit(maxSeriesCovers.value),
  }),
  initialize: async () => {},
  fetchPage: async (query) => {
    const response = await $fetch<{
      data?: { series?: BrowseCardRow[]; hasMore?: boolean };
    }>('/api/series', { query: { ...query, artPreviews: '1' } });
    return {
      rows: response.data?.series ?? [],
      hasMore: response.data?.hasMore ?? false,
    };
  },
  failureMessage: 'Failed to load series',
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

    <div class="flex w-full h-full overflow-hidden">
      <!-- Main content (fixed header + scrollable content area) -->
      <div class="flex-1 overflow-hidden flex flex-col min-h-0">
        <!-- Header (non-scrolling): view selector stays fixed -->
        <div class="px-2 shrink-0 border-b border-(--contrast-border-color)">
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
            <div class="flex flex-wrap items-center justify-between gap-3">
              <input
                v-model="seriesQuery"
                class="px-3 py-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter series..."
                type="text"
              />
              <BrowseCardArtSelect v-model="cardArt" />
            </div>

            <div
              v-if="loadingSeries && !seriesRows.length"
              class="text-sm opacity-80"
            >
              Loading...
            </div>

            <div
              v-else-if="seriesRows.length === 0 && !errorMessage"
              class="text-sm opacity-80"
            >
              No series found in the library.
            </div>

            <!-- Series content -->
            <BrowseCardGrid
              v-else
              page="series"
              :rows="seriesRows"
              :art-style="cardArt"
            />
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
