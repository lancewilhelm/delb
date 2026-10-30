<script setup lang="ts">
import type TagsActions from '~/components/Tags/Actions.vue';
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
const { isAdmin } = useAuth();

const actions = ref<InstanceType<typeof TagsActions> | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);
function onTagContextMenu(event: MouseEvent, tag: TagRow) {
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
function onTagKey(event: KeyboardEvent, tag: TagRow) {
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

type TagRow = {
  id: string;
  name: string;
  bookCount: number;
  books?: Array<{
    id: string;
    title: string;
    coverThumbnailUrl: string | null;
  }>;
};

const tagQuery = ref('');
const userSettingsStore = useUserSettingsStore();
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
} = useEntityPagination<TagRow>({
  inputs: () => ({
    search: tagQuery.value,
    previewLimit: maxTagsCovers.value ?? 8,
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
      data?: { tags?: TagRow[]; hasMore?: boolean };
    }>('/api/tags', { query });
    return {
      rows: response.data?.tags ?? [],
      hasMore: response.data?.hasMore ?? false,
    };
  },
  failureMessage: 'Failed to load tags',
});
const filteredTags = tags;
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
        <div class="px-2 shrink-0 border-b border-(--sub-color)">
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
            <div class="flex items-center justify-between gap-3">
              <input
                ref="filterInput"
                v-model="tagQuery"
                class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter tags..."
                type="text"
              />
            </div>

            <div v-if="loadingTags && !tags.length" class="text-sm opacity-80">
              Loading...
            </div>

            <div
              v-else-if="filteredTags.length === 0 && !errorMessage"
              class="text-sm opacity-80"
            >
              No tags found in the selected collection.
            </div>

            <div v-else class="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              <div
                v-for="t in filteredTags"
                :key="t.id"
                class="relative flex items-center justify-between gap-3 border border-(--sub-color) hover:border-(--main-color) hover:bg-(--sub-color)/10 rounded-md px-3 py-2 overflow-hidden h-32 cursor-pointer shadow-sm hover:shadow-md"
                @contextmenu="onTagContextMenu($event, t)"
                @keydown="onTagKey($event, t)"
              >
                <NuxtLink
                  :to="`/tags/${encodeURIComponent(t.id)}`"
                  class="absolute inset-0 z-100"
                  :aria-label="`View ${t.name}`"
                />
                <div class="min-w-0 z-101 pointer-events-none">
                  <div class="text-wrap">
                    {{ t.name }}
                  </div>
                  <div class="text-xs opacity-70">
                    {{ t.bookCount }} book{{ t.bookCount === 1 ? '' : 's' }}
                  </div>
                </div>

                <div
                  v-if="
                    (t.books ?? []).some(
                      (b) =>
                        typeof b.coverThumbnailUrl === 'string' &&
                        b.coverThumbnailUrl,
                    )
                  "
                  class="shrink-0 flex items-center h-full"
                >
                  <BookCover
                    v-for="(b, i) in (t.books ?? [])
                      .filter(
                        (x) =>
                          typeof x.coverThumbnailUrl === 'string' &&
                          x.coverThumbnailUrl,
                      )
                      .slice(
                        0,
                        maxTagsCovers === -1 ? t.books?.length : maxTagsCovers,
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
