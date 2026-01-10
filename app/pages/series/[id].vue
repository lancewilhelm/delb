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

type Book = {
  id: string;
  title: string;
  coverImagePath?: string | null;

  // List API denormalized fields (best-effort)
  authors?: { id: string; name: string }[];
  authorNames?: string[];
  author?: string;

  publisher?: { id: string; name: string } | null;
  series?: { id: string; name: string } | null;
  seriesIndex?: number | null;

  description?: string | null;

  createdAt: string | number | Date;
};

type SeriesBooksResponse = {
  data?: {
    series?: { id: string; name: string } | null;
    books?: Book[];
  };
  success?: boolean;
  message?: string;
};

const route = useRoute();
const collectionsStore = useCollectionsStore();

const seriesParam = computed(() => String(route.params.id || '').trim());
const seriesId = computed(() => decodeURIComponent(seriesParam.value));

const loading = ref(false);
const errorMessage = ref<string | null>(null);

const seriesName = ref<string>('Series');
const books = ref<Book[]>([]);

const bookCount = computed(() => books.value.length);

function deriveSeriesNameFromBooks(list: Book[], id: string) {
  for (const b of list) {
    if (b.series?.id === id && b.series?.name) return b.series.name;
  }
  return 'Series';
}

function coverThumbUrl(coverImagePath: string) {
  // Stored as a relative `library/...` path (typically `.../thumb.webp`)
  // API expects: /api/media/covers/<path under library>
  return `/api/media/covers/${coverImagePath.replace(/^library\//, '')}`;
}

async function refresh() {
  if (!seriesId.value) return;

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

    const res = await $fetch<SeriesBooksResponse>(
      `/api/series/${encodeURIComponent(seriesId.value)}/books`,
      {
        method: 'GET',
        query,
      },
    );

    const list = res?.data?.books ?? [];

    // Endpoint already returns newest-first, but keep this deterministic in UI.
    list.sort((a, b) => {
      const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    books.value = list;

    // Prefer explicit series metadata returned by the API.
    if (res?.data?.series?.name) {
      seriesName.value = res.data.series.name;
    } else {
      seriesName.value = deriveSeriesNameFromBooks(list, seriesId.value);
    }

    useHead({
      title: `${seriesName.value} · Series`,
    });
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load series';
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

watch(seriesId, () => {
  refresh();
});

// Refresh when the active collection scope changes in the header
watch(
  () => collectionsStore.activeSelection,
  () => {
    refresh();
  },
  { deep: true },
);
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

    <div class="w-full h-full p-4 overflow-auto">
      <div class="flex items-center gap-2 mb-2 text-(--main-color)">
        <Icon
          v-tooltip="'Go back'"
          name="lucide:arrow-left"
          class="opacity-80 hover:opacity-100 cursor-pointer text-3xl"
          @click="navigateTo('/')"
        />
      </div>

      <div v-if="loading" class="text-sm opacity-80">Loading...</div>

      <div v-else-if="errorMessage" class="text-sm text-red-600">
        {{ errorMessage }}
      </div>

      <div v-else-if="books.length === 0" class="text-sm opacity-80">
        No books found for this series in your accessible collections.
      </div>

      <div v-else class="flex flex-col gap-4">
        <div class="flex items-center gap-3">
          <div class="text-2xl sm:text-3xl font-serif truncate">
            {{ seriesName }}
          </div>
          <div class="text-sm sm:text-md opacity-70 italic">
            {{ bookCount }} book{{ bookCount === 1 ? '' : 's' }}
          </div>
        </div>
        <div class="flex flex-col gap-3 flex-wrap">
          <div
            v-for="b in books"
            :key="b.id"
            :book="b"
            class="grid grid-cols-[min-content_auto_3fr] gap-4"
          >
            <div class="text-xl sm:text-2xl self-center text-(--sub-color)">
              {{ b.seriesIndex }}
            </div>
            <BookCover
              :src="coverThumbUrl(b.coverImagePath ?? '')"
              :alt="b.title"
              :title="b.title"
              class="cursor-pointer w-25! sm:w-40!"
              @click="navigateTo(`/books/${b.id}`)"
            />
            <div class="flex flex-col">
              <!-- Title -->
              <div
                class="text-xl sm:text-3xl leading-tight font-serif hover:underline cursor-pointer"
                @click="navigateTo(`/books/${b.id}`)"
              >
                {{ b.title }}
              </div>

              <!-- Authors -->
              <div class="text-md sm:text-lg font-light opacity-80 font-serif">
                <span v-for="(a, index) in b.authors" :key="a.id">
                  <span
                    class="cursor-pointer hover:underline"
                    @click="navigateTo(`/authors/${a.id}`)"
                  >
                    {{ a.name }}
                  </span>
                  <span v-if="b.authors && index < b.authors.length - 1"
                    >,
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
