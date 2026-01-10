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
const collectionsStore = useCollectionsStore();

const tagParam = computed(() => String(route.params.id || '').trim());
const tagId = computed(() => decodeURIComponent(tagParam.value));

const errorMessage = ref<string | null>(null);
const tagName = ref<string>('Tag');
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

const endpoint = computed(() => {
  if (!tagId.value) return '/api/books';
  return `/api/tags/${encodeURIComponent(tagId.value)}/books`;
});

async function refreshHeaderName() {
  if (!tagId.value) return;

  // Ensure collections are loaded so scoped queries work
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }

  try {
    const query: Record<string, string | number> = { limit: 1 };
    if (activeCollectionId.value) query.collectionId = activeCollectionId.value;

    // Prefer explicit tag metadata returned by the API.
    const res = await $fetch<{
      data?: {
        tag?: { id: string; name: string } | null;
      };
    }>(endpoint.value, {
      method: 'GET',
      query,
    });

    if (res?.data?.tag?.name) {
      tagName.value = res.data.tag.name;
    } else if (tagId.value.startsWith('name:')) {
      const raw = tagId.value.slice('name:'.length);
      tagName.value = raw || 'Tag';
    } else {
      tagName.value = 'Tag';
    }

    useHead({ title: `${tagName.value} · Tag` });
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load tag';
  }
}

function handleGridError(message: string) {
  errorMessage.value = message;
}

watch(tagId, async () => {
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

    <div class="flex-1 overflow-hidden flex flex-col min-h-0">
      <!-- Header (non-scrolling) -->
      <div class="p-4 shrink-0">
        <div class="flex items-center gap-2 text-(--main-color)">
          <NuxtLink
            v-tooltip="'Go back'"
            to="/"
            class="opacity-80 hover:opacity-100"
          >
            <Icon name="lucide:arrow-left" />
          </NuxtLink>

          <div class="text-2xl font-serif truncate">
            {{ tagName }}
          </div>

          <div class="text-sm opacity-70">
            · {{ bookCount }} book{{ bookCount === 1 ? '' : 's' }}
          </div>
        </div>

        <div v-if="errorMessage" class="text-sm text-red-600 mt-2">
          {{ errorMessage }}
        </div>
      </div>

      <!-- Body: only the books grid scrolls -->
      <BooksInfiniteGrid
        :key="gridKey"
        :endpoint="endpoint"
        :collection-id="activeCollectionId"
        class="flex-1 min-h-0"
        @error="handleGridError"
        @update:count="(n) => (bookCount = n)"
      />
    </div>
  </div>
</template>
