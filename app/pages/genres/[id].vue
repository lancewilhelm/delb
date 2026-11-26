<script setup lang="ts">
import { useHead } from '~/composables/useHead';
import { useUiStore } from '~/stores/ui';
import { $fetch } from '~/utils/apiFetch';
import { navigateTo } from '~/utils/navigation';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from '~/components/AppHeader.vue';
import BooksInfiniteGrid from '~/components/Books/BooksInfiniteGrid.vue';
import BooksInfiniteList from '~/components/Books/BooksInfiniteList.vue';
import BooksSortDropdown from '~/components/Books/SortDropdown.vue';
import BooksViewToggle from '~/components/Books/BooksViewToggle.vue';
import GenresActions from '~/components/Genres/Actions.vue';
import ViewSelectorDropdown from '~/components/ViewSelectorDropdown.vue';
type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

const route = useRoute();
const uiStore = useUiStore();

const genreParam = computed(() => String(route.params.id || '').trim());
const genreId = computed(() => decodeURIComponent(genreParam.value));

const errorMessage = ref<string | null>(null);
const genreName = ref<string>('Genre');
const loadedGenre = ref<{ id: string; name: string } | null>(null);
let headerGeneration = 0;
const bookCount = ref<number>(0);

const gridKey = ref(0);

const booksViewMode = computed(() => uiStore.booksViewMode);
const hydrated = ref(false);
onMounted(() => {
  hydrated.value = true;
});
const effectiveBooksViewMode = computed(() =>
  hydrated.value ? booksViewMode.value : 'grid',
);

const endpoint = computed(() => {
  if (!genreId.value) return '/api/books';
  return `/api/genres/${encodeURIComponent(genreId.value)}/books`;
});

async function refreshHeaderName() {
  const generation = ++headerGeneration;
  const requestedGenreId = genreId.value;
  const requestedEndpoint = endpoint.value;
  loadedGenre.value = null;
  if (!requestedGenreId) return;

  if (generation !== headerGeneration) return;
  try {
    const query: Record<string, string | number> = { limit: 1 };

    const res = await $fetch<{
      data?: {
        genre?: { id: string; name: string } | null;
      };
    }>(requestedEndpoint, {
      method: 'GET',
      query,
    });

    if (generation !== headerGeneration || requestedGenreId !== genreId.value)
      return;
    if (res?.data?.genre?.id === requestedGenreId) {
      loadedGenre.value = res.data.genre;
      genreName.value = res.data.genre.name;
    } else if (requestedGenreId.startsWith('name:')) {
      const raw = requestedGenreId.slice('name:'.length);
      genreName.value = raw || 'Genre';
    } else {
      genreName.value = 'Genre';
    }

    useHead({ title: `${genreName.value} · Genre` });
  } catch (err) {
    if (generation !== headerGeneration) return;
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load genre';
  }
}

function onGenreChanged(targetId?: string) {
  void navigateTo(
    targetId ? `/genres/${encodeURIComponent(targetId)}` : '/genres',
  );
}

function handleGridError(message: string) {
  errorMessage.value = message;
}

watch(genreId, async () => {
  errorMessage.value = null;
  loadedGenre.value = null;
  bookCount.value = 0;
  gridKey.value++;
  await refreshHeaderName();
});

onMounted(async () => {
  await refreshHeaderName();
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />
    <div class="px-2 shrink-0 border-b border-(--contrast-border-color)">
      <div class="flex items-center justify-between gap-2">
        <ViewSelectorDropdown />
        <div class="flex items-center gap-3">
          <BooksSortDropdown /><BooksViewToggle />
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-hidden flex flex-col min-h-0">
      <div class="p-4 shrink-0">
        <div class="flex items-center gap-2 text-(--contrast-main-color)">
          <Icon
            v-tooltip="'Go back'"
            name="lucide:arrow-left"
            class="opacity-80 hover:opacity-100 cursor-pointer text-3xl"
            @click="$router.back()"
          />

          <div class="text-2xl sm:text-3xl font-serif truncate">
            {{ genreName }}
          </div>

          <GenresActions
            v-if="loadedGenre?.id === genreId"
            :genre="loadedGenre"
            @changed="onGenreChanged"
          />
          <div
            class="text-sm sm:text-md opacity-70 italic text-(--contrast-sub-color)"
          >
            {{ bookCount }} book{{ bookCount === 1 ? '' : 's' }}
          </div>
        </div>

        <div
          v-if="errorMessage"
          class="text-sm [--contrast-status-color:var(--color-red-600)] mt-2 contrast-status"
        >
          {{ errorMessage }}
        </div>
      </div>

      <BooksInfiniteGrid
        v-if="effectiveBooksViewMode === 'grid'"
        :key="`${gridKey}-${effectiveBooksViewMode}`"
        :endpoint="endpoint"
        :sort="uiStore.booksSortKey"
        :sort-dir="uiStore.booksSortDirection"
        class="flex-1 min-h-0"
        @error="handleGridError"
        @update:count="(n: number) => (bookCount = n)"
      />
      <BooksInfiniteList
        v-else
        :key="`${gridKey}-${effectiveBooksViewMode}`"
        :endpoint="endpoint"
        :sort="uiStore.booksSortKey"
        :sort-dir="uiStore.booksSortDirection"
        class="flex-1 min-h-0"
        @error="handleGridError"
        @update:count="(n: number) => (bookCount = n)"
      />
    </div>
  </div>
</template>
