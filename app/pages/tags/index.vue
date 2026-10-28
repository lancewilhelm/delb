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

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type TagsListResponse = {
  data?: {
    hasMore?: boolean;
    tags?: Array<{
      id: string;
      name: string;
      bookCount: number;
      books?: Array<{
        id: string;
        title: string;
        coverThumbnailUrl: string | null;
      }>;
    }>;
  };
};

const errorMessage = ref<string | null>(null);

// ------------------------------
// Tags view
// ------------------------------
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

const tags = ref<TagRow[]>([]);
const loadingTags = ref(false);
const tagQuery = ref('');

const filteredTags = tags;
const hasMore = ref(false);
let generation = 0;
const userSettingsStore = useUserSettingsStore();
const maxTagsCovers = userSettingsStore.settingRef<number>(
  'coverStyle.tagsMaxCovers',
);

async function refreshTags(append = false) {
  const request = append ? generation : ++generation;
  loadingTags.value = true;
  errorMessage.value = null;
  if (!append) {
    tags.value = [];
    hasMore.value = false;
  }
  try {
    const query: Record<string, string> = {
      offset: String(append ? tags.value.length : 0),
      search: tagQuery.value.trim(),
      previewLimit: String(maxTagsCovers.value ?? 8),
    };
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }
    const res = await $fetch<TagsListResponse>('/api/tags', { query });
    if (request !== generation) return;
    const list = res.data?.tags ?? [];
    tags.value = append ? [...tags.value, ...list] : list;
    hasMore.value = res.data?.hasMore ?? false;
  } catch (err) {
    if (request !== generation) return;
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load tags';
  } finally {
    if (request === generation) loadingTags.value = false;
  }
}

watch(
  [() => collectionsStore.activeSelection, tagQuery, maxTagsCovers],
  () => {
    void refreshTags();
  },
  { deep: true, flush: 'sync' },
);

onMounted(async () => {
  if (!collectionsStore.collections.length)
    await collectionsStore.fetchCollections();
  await refreshTags();
});
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
            <!-- Simple navigation menu -->
            <ViewSelectorDropdown />
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <div class="flex-1 min-h-0 overflow-auto p-4 space-y-6">
            <!-- Tags -->
            <div class="flex items-center justify-between gap-3">
              <input
                v-model="tagQuery"
                class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter tags..."
                type="text"
              />
            </div>

            <div v-if="loadingTags && !tags.length" class="text-sm opacity-80">
              Loading...
            </div>

            <div v-else-if="errorMessage" class="text-sm text-(--error-color)">
              {{ errorMessage }}
            </div>

            <div
              v-else-if="filteredTags.length === 0"
              class="text-sm opacity-80"
            >
              No tags found in the selected collection.
            </div>

            <div v-else class="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              <div
                v-for="t in filteredTags"
                :key="t.id"
                class="flex items-center justify-between gap-3 border border-(--sub-color) hover:border-(--main-color) hover:bg-(--sub-color)/10 rounded-md px-3 py-2 overflow-hidden h-32 cursor-pointer shadow-sm hover:shadow-md"
                @click="router.push(`/tags/${t.id}`)"
              >
                <div class="min-w-0 z-101">
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
            <button
              v-if="hasMore"
              type="button"
              class="px-3 py-2 rounded-md border border-(--sub-color) text-sm"
              :disabled="loadingTags"
              @click="refreshTags(true)"
            >
              {{ loadingTags ? 'Loading...' : 'Load more' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
