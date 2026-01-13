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

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type PublishersListResponse = {
  data?: {
    publishers?: Array<{
      id: string;
      name: string;
      bookCount: number;
    }>;
  };
};

const errorMessage = ref<string | null>(null);

// ------------------------------
// Publishers view
// ------------------------------
type PublisherRow = {
  id: string;
  name: string;
  bookCount: number;
};

const publishers = ref<PublisherRow[]>([]);
const loadingPublishers = ref(false);
const publisherQuery = ref('');

const filteredPublishers = computed(() => {
  const q = publisherQuery.value.trim().toLowerCase();
  const list = publishers.value;
  if (!q) return list;
  return list.filter((p) => p.name.toLowerCase().includes(q));
});

async function refreshPublishers() {
  loadingPublishers.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    // Use dedicated list endpoint so this view isn't dependent on how many books were loaded.
    const res = await $fetch<PublishersListResponse>('/api/publishers', {
      method: 'GET',
      query,
    });

    const list = res?.data?.publishers ?? [];

    // Keep client-side sort stable/predictable (server may already sort).
    publishers.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load publishers';
    publishers.value = [];
  } finally {
    loadingPublishers.value = false;
  }
}

// ------------------------------
// UI helpers
// ------------------------------
// When scope changes, refresh the result set for the active view.
watch(
  () => collectionsStore.activeSelection,
  async () => {
    // When scope changes, refresh the result set for the active view.
    await refreshActiveView();
  },
  { deep: true },
);

async function refreshActiveView() {
  // Ensure collections are loaded so collection-scoped queries are valid after navigation.
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }

  await refreshPublishers();
}

onMounted(async () => {
  await refreshActiveView();
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" @book-uploaded="console.log('book uploaded')" />

    <div class="flex w-full h-full overflow-hidden">
      <!-- Sidebar intentionally removed from index page in favor of filter dropdown next to Sort -->

      <!-- Main content (fixed header + scrollable content area) -->
      <div class="flex-1 overflow-hidden flex flex-col min-h-0">
        <!-- Header (non-scrolling): view selector stays fixed -->
        <div class="px-4 shrink-0 border-b border-(--sub-color)">
          <div class="flex items-center justify-between gap-4">
            <!-- Simple navigation menu -->
            <ViewSelectorDropdown />
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <div class="flex-1 min-h-0 overflow-auto p-4 space-y-6">
            <!-- Publishers -->
            <div class="flex items-center justify-between gap-3">
              <input
                v-model="publisherQuery"
                class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter publishers..."
                type="text"
              />
            </div>

            <div v-if="loadingPublishers" class="text-sm opacity-80">
              Loading...
            </div>

            <div v-else-if="errorMessage" class="text-sm text-red-600">
              {{ errorMessage }}
            </div>

            <div
              v-else-if="filteredPublishers.length === 0"
              class="text-sm opacity-80"
            >
              No publishers found in the selected collection.
            </div>

            <div v-else class="mt-3 space-y-2">
              <div
                v-for="p in filteredPublishers"
                :key="p.id"
                class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2 overflow-hidden"
              >
                <div class="min-w-0">
                  <NuxtLink
                    :to="`/publishers/${p.id}`"
                    class="truncate hover:underline"
                  >
                    {{ p.name }}
                  </NuxtLink>
                  <div class="text-xs opacity-70">
                    {{ p.bookCount }} book{{ p.bookCount === 1 ? '' : 's' }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
