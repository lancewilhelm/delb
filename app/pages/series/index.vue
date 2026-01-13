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

type SeriesListResponse = {
  data?: {
    series?: Array<{
      id: string;
      name: string;
      bookCount: number;
    }>;
  };
};

const errorMessage = ref<string | null>(null);

// ------------------------------
// Series view
// ------------------------------
type SeriesRow = {
  id: string;
  name: string;
  bookCount: number;
};

const seriesRows = ref<SeriesRow[]>([]);
const loadingSeries = ref(false);
const seriesQuery = ref('');

const filteredSeries = computed(() => {
  const q = seriesQuery.value.trim().toLowerCase();
  const list = seriesRows.value;
  if (!q) return list;
  return list.filter((s) => s.name.toLowerCase().includes(q));
});

async function refreshSeries() {
  loadingSeries.value = true;
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
    const res = await $fetch<SeriesListResponse>('/api/series', {
      method: 'GET',
      query,
    });

    const list = res?.data?.series ?? [];

    // Keep client-side sort stable/predictable (server may already sort).
    seriesRows.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load series';
    seriesRows.value = [];
  } finally {
    loadingSeries.value = false;
  }
}

// ------------------------------
// UI helpers
// ------------------------------
watch(
  () => collectionsStore.activeSelection,
  async () => {
    await refreshActiveView();
  },
  { deep: true },
);

async function refreshActiveView() {
  // Ensure collections are loaded so collection-scoped queries are valid after navigation.
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }

  await refreshSeries();
}

onMounted(async () => {
  await refreshActiveView();
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" @book-uploaded="console.log('book uploaded')" />

    <div class="flex w-full h-full overflow-hidden">
      <!-- Main content (fixed header + scrollable content area) -->
      <div class="flex-1 overflow-hidden flex flex-col min-h-0">
        <!-- Header (non-scrolling): view selector stays fixed -->
        <div class="px-4 shrink-0 border-b border-(--sub-color)">
          <div class="flex items-center justify-between gap-4">
            <!-- View selector (mode) lives here (top-left) -->
            <ViewSelectorDropdown />
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
          <div class="flex-1 min-h-0 overflow-auto p-4 space-y-6">
            <!-- Series -->
            <div class="flex items-center justify-between gap-3">
              <input
                v-model="seriesQuery"
                class="px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color) text-sm w-56"
                placeholder="Filter series..."
                type="text"
              />
            </div>

            <div v-if="loadingSeries" class="text-sm opacity-80">
              Loading...
            </div>

            <div v-else-if="errorMessage" class="text-sm text-red-600">
              {{ errorMessage }}
            </div>

            <div
              v-else-if="filteredSeries.length === 0"
              class="text-sm opacity-80"
            >
              No series found in the selected collection.
            </div>

            <div v-else class="mt-3 space-y-2">
              <div
                v-for="s in filteredSeries"
                :key="s.id"
                class="flex items-center justify-between border border-(--sub-color) rounded-md px-3 py-2 overflow-hidden"
              >
                <div class="min-w-0">
                  <NuxtLink
                    :to="`/series/${s.id}`"
                    class="truncate hover:underline"
                  >
                    {{ s.name }}
                  </NuxtLink>
                  <div class="text-xs opacity-70">
                    {{ s.bookCount }} book{{ s.bookCount === 1 ? '' : 's' }}
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
