<script setup lang="ts">
import type {
  DashboardBook,
  DashboardCounts,
  DashboardData,
  DashboardShelf,
} from '#shared/types/dashboard';

definePageMeta({ auth: { only: 'user', redirectGuestTo: '/login' } });
useHead({ title: 'Dashboard' });

const collectionsStore = useCollectionsStore();
const booksIndexFiltersStore = useBooksIndexFiltersStore();
const { user } = useAuth();
const route = useRoute();
const router = useRouter();
const displayName = computed(() => user.value?.name?.trim() || 'there');
const collectionName = computed(() =>
  collectionsStore.activeSelection.kind === 'all'
    ? 'All'
    : (collectionsStore.activeCollection?.name ?? ''),
);
const selectedShelf = computed<DashboardShelf>(() =>
  route.query.shelf === 'recent' ? route.query.shelf : 'reading',
);
const scope = computed(() =>
  collectionsStore.activeSelection.kind === 'collection'
    ? collectionsStore.activeSelection.collectionId
    : '',
);
const shelves = [
  {
    key: 'reading',
    label: 'Continue reading',
    subtitle: 'Pick up where you left off',
    empty: 'No books marked as Reading.',
  },
  {
    key: 'recent',
    label: 'Recently read',
    subtitle: 'Date read · newest first',
    empty: 'Finished books with a date read will appear here, newest first.',
  },
] satisfies {
  key: DashboardShelf;
  label: string;
  subtitle: string;
  empty: string;
}[];
const shelfInfo = computed(
  () =>
    shelves.find((shelf) => shelf.key === selectedShelf.value) ?? shelves[0]!,
);
const counts = ref<DashboardCounts | null>(null);
const shelfBooks = ref<DashboardBook[]>([]);
const nextOffset = ref<number | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const errorMessage = ref('');
const failedAppend = ref(false);
let requestNumber = 0;
let controller: AbortController | undefined;
let loadedScope: string | undefined;
let disposed = false;

const stats = computed(
  () =>
    [
      { key: 'total', label: 'All books', to: '/books' },
      { key: 'reading', label: 'Reading', to: '/books?status=reading' },
      {
        key: 'to_be_read',
        label: 'To be read',
        to: '/to-be-read',
      },
      { key: 'finished', label: 'Finished', to: '/books?status=finished' },
      { key: 'dnf', label: 'DNF', to: '/books?status=dnf' },
      { key: 'none', label: 'No status', to: '/books?status=none' },
    ] satisfies { key: keyof DashboardCounts; label: string; to: string }[],
);

async function loadDashboard(append = false) {
  if (disposed || (append && (loading.value || loadingMore.value))) return;
  const offset = append ? nextOffset.value : 0;
  if (offset === null) return;
  const request = ++requestNumber;
  controller?.abort();
  controller = new AbortController();
  loading.value = !append;
  loadingMore.value = append;
  errorMessage.value = '';
  if (!append) {
    shelfBooks.value = [];
    nextOffset.value = null;
    if (loadedScope !== scope.value) counts.value = null;
  }
  try {
    const response = await $fetch<{ success: true; data: DashboardData }>(
      '/api/dashboard',
      {
        query: {
          shelf: selectedShelf.value,
          collectionId: scope.value,
          offset,
        },
        signal: controller.signal,
      },
    );
    if (request !== requestNumber) return;
    counts.value = response.data.counts;
    shelfBooks.value = append
      ? [...shelfBooks.value, ...response.data.shelf.books]
      : response.data.shelf.books;
    nextOffset.value = response.data.shelf.nextOffset;
    loadedScope = scope.value;
  } catch {
    if (request !== requestNumber) return;
    errorMessage.value = 'Could not load this shelf. Please try again.';
    failedAppend.value = append;
  } finally {
    if (request === requestNumber) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function selectShelf(shelf: DashboardShelf) {
  void router.replace({ query: { ...route.query, shelf } });
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  const direction =
    event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!direction && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? shelves.length - 1
        : (index + direction + shelves.length) % shelves.length;
  const shelf = shelves[next];
  if (!shelf) return;
  selectShelf(shelf.key);
  if (event.currentTarget instanceof HTMLElement) {
    const tabs =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      );
    tabs?.[next]?.focus();
  }
}

function readDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
}

watch([scope, selectedShelf], () => {
  void loadDashboard();
});
onMounted(async () => {
  if (!collectionsStore.collections.length)
    await collectionsStore.fetchCollections();
  await loadDashboard();
});
onBeforeUnmount(() => {
  disposed = true;
  ++requestNumber;
  controller?.abort();
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />
    <div class="px-4 shrink-0 border-b border-(--contrast-border-color)">
      <div class="flex items-center justify-center">
        <ViewSelectorDropdown />
      </div>
    </div>
    <div class="flex-1 min-h-0 overflow-auto">
      <main class="dashboard">
        <header class="dashboard-greeting">
          <h1>Hello, {{ displayName }}.</h1>
          <p>
            Collection: <span>{{ collectionName }}</span>
          </p>
        </header>

        <nav class="dashboard-counts" aria-label="Book counts">
          <NuxtLink
            v-for="stat in stats"
            :key="stat.key"
            :to="stat.to"
            class="dashboard-count"
            @click="stat.key === 'total' && booksIndexFiltersStore.clearAll()"
          >
            <span class="dashboard-count-value">{{
              counts?.[stat.key]?.toLocaleString() ?? '—'
            }}</span>
            <span class="dashboard-count-label">{{ stat.label }}</span>
          </NuxtLink>
        </nav>

        <div class="dashboard-shelf-toolbar">
          <div class="dashboard-tabs" role="tablist" aria-label="Book shelves">
            <button
              v-for="(shelf, index) in shelves"
              :id="`shelf-tab-${shelf.key}`"
              :key="shelf.key"
              type="button"
              role="tab"
              :aria-selected="selectedShelf === shelf.key"
              aria-controls="dashboard-shelf"
              :tabindex="selectedShelf === shelf.key ? 0 : -1"
              @click="selectShelf(shelf.key)"
              @keydown="onTabKeydown($event, index)"
            >
              {{ shelf.label }}
            </button>
          </div>
          <NuxtLink
            v-if="selectedShelf === 'reading'"
            to="/books?status=reading"
            class="dashboard-view-all"
            >View all</NuxtLink
          >
        </div>

        <section
          id="dashboard-shelf"
          class="dashboard-shelf"
          role="tabpanel"
          :aria-labelledby="`shelf-tab-${selectedShelf}`"
          :aria-busy="loading || loadingMore"
          tabindex="0"
        >
          <p class="dashboard-subtitle">{{ shelfInfo.subtitle }}</p>
          <p v-if="loading" class="dashboard-message" role="status">Loading…</p>
          <p
            v-else-if="!errorMessage && !shelfBooks.length"
            class="dashboard-message"
          >
            {{ shelfInfo.empty }}
          </p>
          <div v-else-if="shelfBooks.length" class="dashboard-books">
            <article
              v-for="book in shelfBooks"
              :key="book.id"
              class="dashboard-book"
            >
              <BookThumbnail
                :book="book"
                :lock-aspect-ratio="true"
                @status-change="loadDashboard()"
              />
              <div class="dashboard-book-meta">
                <span v-if="selectedShelf === 'recent' && book.finishedDate"
                  >Read {{ readDate(book.finishedDate) }}</span
                >
                <span v-else-if="selectedShelf === 'reading'">{{
                  typeof book.progress === 'number'
                    ? `${book.progress.toFixed(1)}%`
                    : '—'
                }}</span>
              </div>
            </article>
          </div>
          <div v-if="errorMessage" class="dashboard-error" role="alert">
            {{ errorMessage }}
            <button type="button" @click="loadDashboard(failedAppend)">
              Retry
            </button>
          </div>
          <button
            v-if="nextOffset !== null && !errorMessage"
            type="button"
            class="dashboard-show-more"
            :disabled="loadingMore"
            @click="loadDashboard(true)"
          >
            {{ loadingMore ? 'Loading…' : 'Show more' }}
          </button>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  box-sizing: border-box;
  width: min(100%, 1000px);
  margin: auto;
  padding: 48px 28px;
  color: var(--contrast-text-color);
}
.dashboard-greeting {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 32px;
}
.dashboard-greeting h1 {
  margin: 0;
  font:
    300 32px/1.2 Georgia,
    'Times New Roman',
    serif;
  letter-spacing: -1px;
}
.dashboard-greeting p {
  margin: 0;
  font-size: 14px;
  opacity: 0.7;
}
.dashboard-greeting p span {
  font-weight: 500;
}
.dashboard-counts {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  padding-bottom: 28px;
  border-bottom: 1px solid var(--contrast-border-color);
  margin-bottom: 32px;
}
.dashboard-count {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 16px;
  color: inherit;
  text-decoration: none;
  border-right: 1px solid
    color-mix(in srgb, var(--contrast-border-color) 55%, transparent);
}
.dashboard-count:first-child {
  padding-left: 0;
}
.dashboard-count:last-child {
  border-right: 0;
}
.dashboard-count:hover {
  background: color-mix(in srgb, var(--sub-color) 10%, transparent);
}
.dashboard-count-value {
  font-size: 28px;
  line-height: 32px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.dashboard-count-label {
  font-size: 12px;
  line-height: 18px;
  opacity: 0.7;
}
.dashboard-shelf-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.dashboard-tabs {
  display: flex;
  gap: 26px;
  min-width: 0;
}
.dashboard-tabs button {
  font: inherit;
  color: inherit;
  background: transparent;
  border-radius: 0;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 8px 0 12px;
  font-size: 14px;
  opacity: 0.6;
  white-space: nowrap;
}
.dashboard-tabs button[aria-selected='true'] {
  border-bottom-color: var(--main-color);
  opacity: 1;
  font-weight: 500;
}
.dashboard-tabs button:hover {
  opacity: 1;
}
.dashboard-view-all {
  color: inherit;
  opacity: 0.7;
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
  margin-left: auto;
}
.dashboard-view-all:hover {
  text-decoration: underline;
}
.dashboard-subtitle {
  font-size: 12px;
  opacity: 0.65;
  margin: 12px 0 20px;
}
.dashboard-books {
  display: flex;
  gap: 20px;
  overflow-x: auto;
  padding: 4px 4px 12px;
  margin: 0 -4px;
}
.dashboard-book {
  width: 140px;
  min-width: 0;
  flex-shrink: 0;
}
.dashboard-book-meta {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 4px;
  margin-top: 8px;
  font-size: 11px;
  line-height: 20px;
}
.dashboard-book-meta > span {
  opacity: 0.65;
}
.dashboard-message {
  font-size: 13px;
  opacity: 0.75;
  margin: 28px 0;
}
.dashboard-error {
  color: var(--contrast-error-color);
  font-size: 13px;
  margin-top: 16px;
}
.dashboard-error button {
  display: inline-flex;
  color: var(--contrast-text-color);
  text-decoration: underline;
  padding: 4px;
  margin-left: 4px;
}
.dashboard-show-more {
  font-size: 12px;
  padding: 8px 12px;
  border: 1px solid var(--contrast-border-color);
  margin-top: 16px;
}
.dashboard-show-more:disabled {
  opacity: 0.6;
  cursor: wait;
}
.dashboard a:focus-visible,
.dashboard button:focus-visible,
.dashboard-shelf:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 4px;
}
@media (max-width: 700px) {
  .dashboard {
    padding: 32px 20px;
  }
  .dashboard-greeting {
    display: block;
    margin-bottom: 28px;
  }
  .dashboard-greeting p {
    margin-top: 10px;
  }
  .dashboard-counts {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    row-gap: 24px;
    margin-bottom: 28px;
  }
  .dashboard-count:nth-child(4) {
    padding-left: 0;
  }
  .dashboard-count:nth-child(3) {
    border-right: 0;
  }
  .dashboard-tabs {
    gap: 18px;
  }
  .dashboard-tabs button {
    font-size: 12px;
  }
  .dashboard-shelf-toolbar {
    flex-wrap: wrap;
  }
  .dashboard-books {
    gap: 16px;
  }
  .dashboard-book {
    width: 128px;
  }
}
</style>
