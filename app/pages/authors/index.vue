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

const authorQuery = ref('');
const userSettingsStore = useUserSettingsStore();
const cardArt = userSettingsStore.settingRef<CardArtStyle>(
  'browseCardArt.authors',
);
const maxAuthorsCovers = userSettingsStore.settingRef<number>(
  'coverStyle.authorsMaxCovers',
);
const {
  rows: authors,
  hasMore,
  loading: loadingAuthors,
  error: errorMessage,
  scrollRoot,
  loadMore,
  retry,
} = useEntityPagination<BrowseCardRow>({
  inputs: () => ({
    search: authorQuery.value,
    previewLimit: browseCardPreviewLimit(maxAuthorsCovers.value),
  }),
  initialize: async () => {},
  fetchPage: async (query) => {
    const response = await $fetch<{
      data?: { authors?: BrowseCardRow[]; hasMore?: boolean };
    }>('/api/authors', { query: { ...query, artPreviews: '1' } });
    return {
      rows: response.data?.authors ?? [],
      hasMore: response.data?.hasMore ?? false,
    };
  },
  failureMessage: 'Failed to load authors',
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

    <div class="flex w-full h-full overflow-hidden">
      <!-- Sidebar intentionally removed from index page in favor of filter dropdown next to Sort -->

      <!-- Main content (fixed header + scrollable content area) -->
      <div class="flex-1 overflow-hidden flex flex-col min-h-0">
        <!-- Header (non-scrolling): view selector stays fixed -->
        <div class="px-2 shrink-0 border-b border-(--contrast-border-color)">
          <div class="flex items-center justify-between gap-4">
            <!-- Simple navigation menu -->
            <ViewSelectorDropdown />
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <div
            ref="scrollRoot"
            class="flex-1 min-h-0 overflow-auto p-4 space-y-6"
          >
            <!-- Authors -->
            <div class="flex flex-wrap items-center justify-between gap-3">
              <input
                v-model="authorQuery"
                class="px-3 py-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter authors..."
                type="text"
              />
              <BrowseCardArtSelect v-model="cardArt" />
            </div>

            <div
              v-if="loadingAuthors && !authors.length"
              class="text-sm opacity-80"
            >
              Loading...
            </div>

            <div
              v-else-if="authors.length === 0 && !errorMessage"
              class="text-sm opacity-80"
            >
              No authors found in the library.
            </div>

            <BrowseCardGrid
              v-else
              page="authors"
              :rows="authors"
              :art-style="cardArt"
            />
            <EntityPaginationControl
              :root="scrollRoot"
              :row-count="authors.length"
              :has-more="hasMore"
              :loading="loadingAuthors"
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
