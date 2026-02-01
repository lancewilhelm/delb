<script setup lang="ts">
definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
});

useHead({
  title: 'Dashboard',
});

const collectionsStore = useCollectionsStore();
const { user } = useAuth();

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type DashboardResponse = {
  success?: boolean;
  data?: {
    counts?: DashboardCounts;
    reading?: { books?: DashboardReadingBook[] };
  };
  message?: string;
};

type DashboardCounts = {
  total: number;
  none: number;
  to_be_read: number;
  reading: number;
  finished: number;
  dnf: number;
};

type DashboardReadingBook = {
  id: string;
  title: string;
  coverImagePath?: string | null;
  progress?: number | null;
};

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const counts = ref<DashboardCounts | null>(null);
const readingBooks = ref<DashboardReadingBook[]>([]);

const displayName = computed(() => {
  const n = (user.value?.name ?? '').toString().trim();
  return n || 'there';
});

async function refreshDashboard() {
  loading.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    const res = await $fetch<DashboardResponse>('/api/dashboard', {
      method: 'GET',
      query,
    });

    counts.value = res?.data?.counts ?? null;
    readingBooks.value = res?.data?.reading?.books ?? [];
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load dashboard';
    counts.value = null;
    readingBooks.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => collectionsStore.activeSelection,
  async () => {
    if (!collectionsStore.collections.length) {
      await collectionsStore.fetchCollections();
    }
    await refreshDashboard();
  },
  { deep: true },
);

onMounted(async () => {
  if (!collectionsStore.collections.length) {
    await collectionsStore.fetchCollections();
  }
  await refreshDashboard();
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

    <div class="flex w-full h-full overflow-hidden">
      <div class="flex-1 overflow-hidden flex flex-col min-h-0">
        <div class="px-4 shrink-0 border-b border-(--sub-color)">
          <div class="flex items-center justify-center">
            <ViewSelectorDropdown />
          </div>
        </div>

        <div
          class="flex-1 min-h-0 overflow-auto p-4 space-y-8 flex items-center justify-center max-w-225 self-center"
        >
          <div v-if="loading" class="text-sm opacity-80">Loading…</div>
          <div v-else-if="errorMessage" class="text-sm text-(--error-color)">
            {{ errorMessage }}
          </div>

          <div v-else class="flex flex-col gap-4">
            <!-- Hero -->
            <div
              class="w-full flex items-center justify-center text-center text-5xl font-thin font-serif"
            >
              Hello, {{ displayName }}.
            </div>

            <!-- Collection info -->
            <div class="text-center text-md opacity-80">
              Active collection:
              <span v-if="collectionsStore.activeSelection.kind === 'all'"
                >All</span
              >
              <span
                v-else-if="
                  collectionsStore.activeSelection.kind === 'collection'
                "
                >{{ collectionsStore.activeCollection?.name }}</span
              >
            </div>

            <!-- Cards -->
            <div class="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <NuxtLink
                to="/books"
                class="border border-(--sub-color) rounded-lg p-4 hover:bg-(--sub-color)/10 transition"
              >
                <Icon
                  name="lucide:library"
                  class="float-right text-(--main-color) opacity-60"
                />
                <div class="text-xs opacity-70">All books</div>
                <div class="text-2xl font-semibold">
                  {{ counts?.total ?? 0 }}
                </div>
              </NuxtLink>

              <NuxtLink
                to="/books?status=reading"
                class="border border-(--sub-color) rounded-lg p-4 hover:bg-(--sub-color)/10 transition"
              >
                <Icon
                  name="lucide:book-open"
                  class="float-right text-(--main-color) opacity-60"
                />
                <div class="text-xs opacity-70">Reading</div>
                <div class="text-2xl font-semibold">
                  {{ counts?.reading ?? 0 }}
                </div>
              </NuxtLink>

              <NuxtLink
                to="/books?status=to_be_read"
                class="border border-(--sub-color) rounded-lg p-4 hover:bg-(--sub-color)/10 transition"
              >
                <Icon
                  name="lucide:bookmark"
                  class="float-right text-(--main-color) opacity-60"
                />
                <div class="text-xs opacity-70">To be read</div>
                <div class="text-2xl font-semibold">
                  {{ counts?.to_be_read ?? 0 }}
                </div>
              </NuxtLink>

              <NuxtLink
                to="/books?status=finished"
                class="border border-(--sub-color) rounded-lg p-4 hover:bg-(--sub-color)/10 transition"
              >
                <Icon
                  name="lucide:check"
                  class="float-right text-(--main-color) opacity-60"
                />
                <div class="text-xs opacity-70">Finished</div>
                <div class="text-2xl font-semibold">
                  {{ counts?.finished ?? 0 }}
                </div>
              </NuxtLink>

              <NuxtLink
                to="/books?status=dnf"
                class="border border-(--sub-color) rounded-lg p-4 hover:bg-(--sub-color)/10 transition"
              >
                <Icon
                  name="lucide:ban"
                  class="float-right text-(--main-color) opacity-60"
                />
                <div class="text-xs opacity-70">DNF</div>
                <div class="text-2xl font-semibold">
                  {{ counts?.dnf ?? 0 }}
                </div>
              </NuxtLink>

              <NuxtLink
                to="/books?status=none"
                class="border border-(--sub-color) rounded-lg p-4 hover:bg-(--sub-color)/10 transition"
              >
                <Icon
                  name="lucide:circle-dashed"
                  class="float-right text-(--main-color) opacity-60"
                />
                <div class="text-xs opacity-70">No status</div>
                <div class="text-2xl font-semibold">
                  {{ counts?.none ?? 0 }}
                </div>
              </NuxtLink>
            </div>

            <!-- Continue reading -->
            <section class="space-y-3 flex flex-col items-center">
              <div class="flex items-center justify-between gap-3 w-full">
                <div class="text-lg font-semibold">Continue reading</div>
                <NuxtLink
                  to="/books?status=reading"
                  class="text-sm opacity-80 hover:opacity-100 hover:underline"
                >
                  View all
                </NuxtLink>
              </div>

              <div v-if="!readingBooks.length" class="text-sm opacity-80">
                No books marked as Reading.
              </div>

              <div v-else class="flex gap-3 overflow-x-auto pb-2">
                <div
                  v-for="b in readingBooks"
                  :key="b.id"
                  class="w-40 shrink-0"
                >
                  <BookThumbnail :book="b" :lock-aspect-ratio="true" />
                  <div class="text-xs opacity-70 mt-1">
                    <span v-if="typeof b.progress === 'number'">
                      {{ b.progress.toFixed(1) }}%
                    </span>
                    <span v-else>—</span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
