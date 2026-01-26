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

const publisherParam = computed(() => String(route.params.id || '').trim());
const publisherId = computed(() => decodeURIComponent(publisherParam.value));

const errorMessage = ref<string | null>(null);
const publisherName = ref<string>('Publisher');
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

const gridEndpoint = computed(() => {
  if (!publisherId.value) return '/api/books';
  return `/api/publishers/${encodeURIComponent(publisherId.value)}/books`;
});

useHead({
  title: `${publisherName.value} · Publisher`,
});

async function refreshHeaderName() {
  if (!publisherId.value) return;

  // Ensure collections are loaded so scoped queries work
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }

  try {
    const query: Record<string, string | number> = { limit: 1 };
    if (activeCollectionId.value) query.collectionId = activeCollectionId.value;

    // Prefer explicit publisher metadata returned by the API.
    const res = await $fetch<{
      data?: {
        publisher?: { id: string; name: string } | null;
      };
    }>(gridEndpoint.value, {
      method: 'GET',
      query,
    });

    if (res?.data?.publisher?.name) {
      publisherName.value = res.data.publisher.name;
    } else if (publisherId.value.startsWith('name:')) {
      const raw = publisherId.value.slice('name:'.length);
      publisherName.value = raw || 'Publisher';
    } else {
      publisherName.value = 'Publisher';
    }

    useHead({
      title: `${publisherName.value} · Publisher`,
    });
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load publisher';
  }
}

function handleGridError(message: string) {
  errorMessage.value = message;
}

watch(
  () => publisherId.value,
  async () => {
    errorMessage.value = null;
    bookCount.value = 0;
    gridKey.value++;
    await refreshHeaderName();
  },
);

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

    <!-- Fixed header + scrollable books grid -->
    <div class="w-full h-full overflow-hidden flex flex-col min-h-0">
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
              {{ publisherName }}
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

      <BooksInfiniteGrid
        :key="gridKey"
        :endpoint="gridEndpoint"
        :collection-id="activeCollectionId"
        class="flex-1 min-h-0"
        @error="handleGridError"
        @update:count="(n: number) => (bookCount = n)"
      />
    </div>
  </div>
</template>
