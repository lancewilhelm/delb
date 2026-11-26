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
import ViewSelectorDropdown from '~/components/ViewSelectorDropdown.vue';
import TagsActions from '~/components/Tags/Actions.vue';

// Page metadata
useHead({
  title: 'Home',
});

const { isAdmin } = useAuth();

const actions = ref<InstanceType<typeof TagsActions> | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);
function onTagContextMenu(event: MouseEvent, tag: BrowseCardRow) {
  if (!isAdmin.value) return;
  event.preventDefault();
  const card = event.currentTarget;
  const link = card instanceof HTMLElement ? card.querySelector('a') : null;
  actions.value?.openFor(tag, {
    kind: 'pointer',
    x: event.clientX,
    y: event.clientY,
    returnFocus: link,
  });
}
function onTagKey(event: KeyboardEvent, tag: BrowseCardRow) {
  if (
    !isAdmin.value ||
    !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
  )
    return;
  const anchor = event.target;
  if (!(anchor instanceof HTMLElement)) return;
  event.preventDefault();
  actions.value?.openFor(tag, { kind: 'anchor', anchor, returnFocus: anchor });
}
function focusFilter() {
  filterInput.value?.focus();
}

const tagQuery = ref('');
const userSettingsStore = useUserSettingsStore();
const cardArt =
  userSettingsStore.settingRef<CardArtStyle>('browseCardArt.tags');
const maxTagsCovers = userSettingsStore.settingRef<number>(
  'coverStyle.tagsMaxCovers',
);
const {
  rows: tags,
  hasMore,
  loading: loadingTags,
  error: errorMessage,
  scrollRoot,
  reset: refreshTags,
  loadMore,
  retry,
} = useEntityPagination<BrowseCardRow>({
  inputs: () => ({
    search: tagQuery.value,
    previewLimit: browseCardPreviewLimit(maxTagsCovers.value),
  }),
  initialize: async () => {},
  fetchPage: async (query) => {
    const response = await $fetch<{
      data?: { tags?: BrowseCardRow[]; hasMore?: boolean };
    }>('/api/tags', { query: { ...query, artPreviews: '1' } });
    return {
      rows: response.data?.tags ?? [],
      hasMore: response.data?.hasMore ?? false,
    };
  },
  failureMessage: 'Failed to load tags',
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />
    <TagsActions
      ref="actions"
      :show-trigger="false"
      :focus-fallback="focusFilter"
      @changed="refreshTags()"
    />

    <div class="flex w-full h-full overflow-hidden">
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
            <!-- Tags -->
            <div class="flex flex-wrap items-center justify-between gap-3">
              <input
                ref="filterInput"
                v-model="tagQuery"
                class="px-3 py-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter tags..."
                type="text"
              />
              <BrowseCardArtSelect v-model="cardArt" />
            </div>

            <div v-if="loadingTags && !tags.length" class="text-sm opacity-80">
              Loading...
            </div>

            <div
              v-else-if="tags.length === 0 && !errorMessage"
              class="text-sm opacity-80"
            >
              No tags found in the library.
            </div>

            <BrowseCardGrid
              v-else
              page="tags"
              :rows="tags"
              :art-style="cardArt"
              @card-contextmenu="onTagContextMenu"
              @card-keydown="onTagKey"
            />
            <EntityPaginationControl
              :root="scrollRoot"
              :row-count="tags.length"
              :has-more="hasMore"
              :loading="loadingTags"
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
