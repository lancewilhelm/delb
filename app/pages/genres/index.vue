<script setup lang="ts">
import { useAuth } from '~/composables/useAuth';
import { useEntityPagination } from '~/composables/useEntityPagination';
import { useHead } from '~/composables/useHead';
import { useUserSettingsStore } from '~/stores/userSettings';
import { $fetch } from '~/utils/apiFetch';
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import AppHeader from '~/components/AppHeader.vue';
import BookCover from '~/components/BookCover.vue';
import EntityPaginationControl from '~/components/EntityPaginationControl.vue';
import GenresActions from '~/components/Genres/Actions.vue';
import ViewSelectorDropdown from '~/components/ViewSelectorDropdown.vue';

useHead({
  title: 'Genres',
});

const { isAdmin } = useAuth();

const actions = ref<InstanceType<typeof GenresActions> | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);
function onGenreContextMenu(event: MouseEvent, genre: GenreRow) {
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
function onGenreKey(event: KeyboardEvent, genre: GenreRow) {
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

type GenreRow = {
  id: string;
  name: string;
  bookCount: number;
  books?: Array<{
    id: string;
    title: string;
    coverThumbnailUrl: string | null;
  }>;
};

const genreQuery = ref('');
const userSettingsStore = useUserSettingsStore();
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
} = useEntityPagination<GenreRow>({
  inputs: () => ({
    search: genreQuery.value,
    previewLimit: maxCovers.value ?? 8,
  }),
  initialize: async () => {},
  fetchPage: async (query) => {
    const response = await $fetch<{
      data?: { genres?: GenreRow[]; hasMore?: boolean };
    }>('/api/genres', { query });
    return {
      rows: response.data?.genres ?? [],
      hasMore: response.data?.hasMore ?? false,
    };
  },
  failureMessage: 'Failed to load genres',
});
const filteredGenres = genres;
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
            <div class="flex items-center justify-between gap-3">
              <input
                ref="filterInput"
                v-model="genreQuery"
                class="px-3 py-2 rounded-md border border-(--contrast-border-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter genres..."
                type="text"
              />
            </div>

            <div
              v-if="loadingGenres && !genres.length"
              class="text-sm opacity-80"
            >
              Loading...
            </div>

            <div
              v-else-if="filteredGenres.length === 0 && !errorMessage"
              class="text-sm opacity-80"
            >
              No genres found in the library.
            </div>

            <div v-else class="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              <div
                v-for="g in filteredGenres"
                :key="g.id"
                class="relative flex items-center justify-between gap-3 border border-(--contrast-border-color) hover:border-(--main-color) hover:bg-(--sub-color)/10 rounded-md px-3 py-2 overflow-hidden min-h-32 cursor-pointer shadow-sm hover:shadow-md"
                @contextmenu="onGenreContextMenu($event, g)"
                @keydown="onGenreKey($event, g)"
              >
                <RouterLink
                  :to="`/genres/${encodeURIComponent(g.id)}`"
                  class="absolute inset-0 z-100"
                  :aria-label="`View ${g.name}`"
                />
                <div class="min-w-0 flex-1 z-101 pointer-events-none">
                  <div class="break-words">
                    {{ g.name }}
                  </div>
                  <div class="text-xs opacity-70">
                    {{ g.bookCount }} book{{ g.bookCount === 1 ? '' : 's' }}
                  </div>
                </div>

                <div
                  v-if="
                    (g.books ?? []).some(
                      (b) =>
                        typeof b.coverThumbnailUrl === 'string' &&
                        b.coverThumbnailUrl,
                    )
                  "
                  class="ml-auto flex h-28 max-w-[45%] shrink-0 items-center justify-end overflow-hidden"
                >
                  <BookCover
                    v-for="(b, i) in (g.books ?? [])
                      .filter(
                        (x) =>
                          typeof x.coverThumbnailUrl === 'string' &&
                          x.coverThumbnailUrl,
                      )
                      .slice(0, maxCovers === -1 ? g.books?.length : maxCovers)"
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
