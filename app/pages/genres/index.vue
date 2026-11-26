<script setup lang="ts">
import { useAuth } from '~/composables/useAuth';
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
import GenresActions from '~/components/Genres/Actions.vue';
import ViewSelectorDropdown from '~/components/ViewSelectorDropdown.vue';

useHead({
  title: 'Genres',
});

const { isAdmin } = useAuth();

const actions = ref<InstanceType<typeof GenresActions> | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);
function onGenreContextMenu(event: MouseEvent, genre: BrowseCardRow) {
  if (!isAdmin.value) return;
  event.preventDefault();
  const card = event.currentTarget;
  const link = card instanceof HTMLElement ? card.querySelector('a') : null;
  actions.value?.openFor(genre, {
    kind: 'pointer',
    x: event.clientX,
    y: event.clientY,
    returnFocus: link,
  });
}
function onGenreKey(event: KeyboardEvent, genre: BrowseCardRow) {
  if (
    !isAdmin.value ||
    !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
  )
    return;
  const anchor = event.target;
  if (!(anchor instanceof HTMLElement)) return;
  event.preventDefault();
  actions.value?.openFor(genre, {
    kind: 'anchor',
    anchor,
    returnFocus: anchor,
  });
}
function focusFilter() {
  filterInput.value?.focus();
}

const genreQuery = ref('');
const userSettingsStore = useUserSettingsStore();
const cardArt = userSettingsStore.settingRef<CardArtStyle>(
  'browseCardArt.genres',
);
const maxCovers = userSettingsStore.settingRef<number>(
  'coverStyle.tagsMaxCovers',
);
const {
  rows: genres,
  hasMore,
  loading: loadingGenres,
  error: errorMessage,
  scrollRoot,
  reset: refreshGenres,
  loadMore,
  retry,
} = useEntityPagination<BrowseCardRow>({
  inputs: () => ({
    search: genreQuery.value,
    previewLimit: browseCardPreviewLimit(maxCovers.value),
  }),
  initialize: async () => {},
  fetchPage: async (query) => {
    const response = await $fetch<{
      data?: { genres?: BrowseCardRow[]; hasMore?: boolean };
    }>('/api/genres', { query: { ...query, artPreviews: '1' } });
    return {
      rows: response.data?.genres ?? [],
      hasMore: response.data?.hasMore ?? false,
    };
  },
  failureMessage: 'Failed to load genres',
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />
    <GenresActions
      ref="actions"
      :show-trigger="false"
      :focus-fallback="focusFilter"
      @changed="refreshGenres()"
    />

    <div class="flex w-full h-full overflow-hidden">
      <div class="flex-1 overflow-hidden flex flex-col min-h-0">
        <div class="px-2 shrink-0 border-b border-(--contrast-border-color)">
          <div class="flex items-center justify-between gap-4">
            <ViewSelectorDropdown />
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <div
            ref="scrollRoot"
            class="flex-1 min-h-0 overflow-auto p-4 space-y-6"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <input
                ref="filterInput"
                v-model="genreQuery"
                class="px-3 py-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter genres..."
                type="text"
              />
              <BrowseCardArtSelect v-model="cardArt" />
            </div>

            <div
              v-if="loadingGenres && !genres.length"
              class="text-sm opacity-80"
            >
              Loading...
            </div>

            <div
              v-else-if="genres.length === 0 && !errorMessage"
              class="text-sm opacity-80"
            >
              No genres found in the library.
            </div>

            <BrowseCardGrid
              v-else
              page="genres"
              :rows="genres"
              :art-style="cardArt"
              @card-contextmenu="onGenreContextMenu"
              @card-keydown="onGenreKey"
            />
            <EntityPaginationControl
              :root="scrollRoot"
              :row-count="genres.length"
              :has-more="hasMore"
              :loading="loadingGenres"
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
