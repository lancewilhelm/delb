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

type AuthorRow = {
  id: string;
  name: string;
  bookCount: number;
  books?: Array<{
    id: string;
    title: string;
    coverThumbnailUrl: string | null;
  }>;
};

const authorQuery = ref('');
const userSettingsStore = useUserSettingsStore();
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
} = useEntityPagination<AuthorRow>({
  inputs: () => ({
    search: authorQuery.value,
    previewLimit: maxAuthorsCovers.value ?? 8,
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
      data?: { authors?: AuthorRow[]; hasMore?: boolean };
    }>('/api/authors', { query });
    return {
      rows: response.data?.authors ?? [],
      hasMore: response.data?.hasMore ?? false,
    };
  },
  failureMessage: 'Failed to load authors',
});
const filteredAuthors = authors;
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

    <div class="flex w-full h-full overflow-hidden">
      <!-- Sidebar intentionally removed from index page in favor of filter dropdown next to Sort -->

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
            <!-- Authors -->
            <div class="flex items-center justify-between gap-3">
              <input
                v-model="authorQuery"
                class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter authors..."
                type="text"
              />
            </div>

            <div
              v-if="loadingAuthors && !authors.length"
              class="text-sm opacity-80"
            >
              Loading...
            </div>

            <div
              v-else-if="filteredAuthors.length === 0 && !errorMessage"
              class="text-sm opacity-80"
            >
              No authors found in the selected collection.
            </div>

            <div v-else class="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              <div
                v-for="a in filteredAuthors"
                :key="a.id"
                class="flex items-center justify-between gap-3 border border-(--sub-color) hover:border-(--main-color) hover:bg-(--sub-color)/10 rounded-md px-3 py-2 overflow-hidden h-32 cursor-pointer shadow-sm hover:shadow-md"
                @click="router.push(`/authors/${a.id}`)"
              >
                <div class="min-w-0 z-101">
                  <div class="text-wrap">
                    {{ a.name }}
                  </div>
                  <div class="text-xs opacity-70">
                    {{ a.bookCount }} book{{ a.bookCount === 1 ? '' : 's' }}
                  </div>
                </div>

                <div
                  v-if="
                    (a.books ?? []).some(
                      (b) =>
                        typeof b.coverThumbnailUrl === 'string' &&
                        b.coverThumbnailUrl,
                    )
                  "
                  class="shrink-0 flex items-center h-full"
                >
                  <BookCover
                    v-for="(b, i) in (a.books ?? [])
                      .filter(
                        (x) =>
                          typeof x.coverThumbnailUrl === 'string' &&
                          x.coverThumbnailUrl,
                      )
                      .slice(
                        0,
                        maxAuthorsCovers === -1
                          ? a.books?.length
                          : maxAuthorsCovers,
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
