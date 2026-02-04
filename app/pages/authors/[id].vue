<script setup lang="ts">
definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
});

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

const route = useRoute();
const uiStore = useUiStore();
const collectionsStore = useCollectionsStore();

const authorParam = computed(() => String(route.params.id || '').trim());
const authorId = computed(() => decodeURIComponent(authorParam.value));

const errorMessage = ref<string | null>(null);
const authorName = ref<string>('Author');
const bookCount = ref<number>(0);

// Used to force-recreate the BooksInfiniteGrid (scope changes, navigation, etc.)
const gridKey = ref(0);

const activeCollectionId = computed<string | undefined>(() => {
  if (
    collectionsStore.activeSelection.kind === 'collection' &&
    collectionsStore.activeSelection.collectionId
  ) {
    return collectionsStore.activeSelection.collectionId;
  }
  return undefined;
});

const booksViewMode = computed(() => uiStore.booksViewMode);
const hydrated = ref(false);
onMounted(() => {
  hydrated.value = true;
});
const effectiveBooksViewMode = computed(() =>
  hydrated.value ? booksViewMode.value : 'grid',
);

const endpoint = computed(() => {
  if (!authorId.value) return '/api/books';
  return `/api/authors/${encodeURIComponent(authorId.value)}/books`;
});

async function refreshHeaderName() {
  if (!authorId.value) return;

  // Ensure collections are loaded so scoped queries work
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }

  try {
    const query: Record<string, string | number> = { limit: 1 };
    if (activeCollectionId.value) query.collectionId = activeCollectionId.value;

    // Prefer explicit author metadata returned by the API.
    const res = await $fetch<{
      data?: {
        author?: { id: string; name: string } | null;
      };
    }>(endpoint.value, {
      method: 'GET',
      query,
    });

    if (res?.data?.author?.name) {
      authorName.value = res.data.author.name;
    } else if (authorId.value.startsWith('name:')) {
      const raw = authorId.value.slice('name:'.length);
      authorName.value = raw || 'Author';
    } else {
      authorName.value = 'Author';
    }

    useHead({ title: `${authorName.value} · Author` });
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load author';
  }
}

function handleGridError(message: string) {
  errorMessage.value = message;
}

watch(authorId, async () => {
  errorMessage.value = null;
  bookCount.value = 0;
  gridKey.value++;
  await refreshHeaderName();
});

watch(
  () => collectionsStore.activeSelection,
  async () => {
    errorMessage.value = null;
    bookCount.value = 0;
    gridKey.value++;
    await refreshHeaderName();
  },
  { deep: true },
);

onMounted(async () => {
  await refreshHeaderName();
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

    <div class="px-2 shrink-0 border-b border-(--sub-color)">
      <div class="flex items-center justify-between gap-2">
        <ViewSelectorDropdown />
        <BooksViewToggle />
      </div>
    </div>

    <div class="flex-1 overflow-hidden flex flex-col min-h-0">
      <!-- Header (non-scrolling) -->
      <div class="p-4 shrink-0">
        <div class="flex items-center gap-2 text-(--main-color)">
          <Icon
            v-tooltip="'Go back'"
            name="lucide:arrow-left"
            class="opacity-80 hover:opacity-100 cursor-pointer text-3xl"
            @click="$router.back()"
          />

          <div class="flex flex-col">
            <div class="text-2xl sm:text-3xl font-serif truncate">
              {{ authorName }}
            </div>

            <div
              class="text-sm sm:text-md opacity-70 italic text-(--sub-color)"
            >
              {{ bookCount }} book{{ bookCount === 1 ? '' : 's' }}
            </div>
          </div>
        </div>

        <div v-if="errorMessage" class="text-sm text-red-600 mt-2">
          {{ errorMessage }}
        </div>
      </div>

      <!-- Body: only the books grid scrolls -->
      <BooksInfiniteGrid
        v-if="effectiveBooksViewMode === 'grid'"
        :key="`${gridKey}-${effectiveBooksViewMode}`"
        :endpoint="endpoint"
        :collection-id="activeCollectionId"
        class="flex-1 min-h-0"
        @error="handleGridError"
        @update:count="(n: number) => (bookCount = n)"
      />
      <BooksInfiniteList
        v-else
        :key="`${gridKey}-${effectiveBooksViewMode}`"
        :endpoint="endpoint"
        :collection-id="activeCollectionId"
        class="flex-1 min-h-0"
        @error="handleGridError"
        @update:count="(n: number) => (bookCount = n)"
      />
    </div>
  </div>
</template>
