<script setup lang="ts">
import { useAuth } from '~/composables/useAuth';
import { useHead } from '~/composables/useHead';
import { useCollectionsStore } from '~/stores/collections';
import {
  useUserSettingsStore,
  type BaseUserSettings,
} from '~/stores/userSettings';
import { $fetch } from '~/utils/apiFetch';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import AppHeader from '~/components/AppHeader.vue';
import ViewSelectorDropdown from '~/components/ViewSelectorDropdown.vue';
import DashboardContinueCard from '~/components/Dashboard/DashboardContinueCard.vue';
import DashboardLibraryCard from '~/components/Dashboard/DashboardLibraryCard.vue';
import DashboardListTile from '~/components/Dashboard/DashboardListTile.vue';
import { primeBookPreviews } from '~/utils/bookPreviewCache';
import type { BookStatusChange } from '~/utils/bookReadingStatus';
import {
  readDashboardCache,
  readShelvesCache,
  writeDashboardCache,
  writeShelvesCache,
  type DashboardShelfSummary,
} from '~/utils/dashboardCache';
import {
  STATUS_LABELS,
  STATUS_ORDER,
  resolveCardArt,
  type CardArtStyle,
  type LibraryArtStyle,
} from '~/utils/dashboardArt';
import type {
  DashboardBook,
  DashboardListKey,
  DashboardOverview,
} from '#shared/types/dashboard';
useHead({ title: 'Dashboard' });

const collectionsStore = useCollectionsStore();
const userSettingsStore = useUserSettingsStore();
const { user } = useAuth();
const displayName = computed(() => user.value?.name?.trim() || 'there');
const collectionName = computed(() =>
  collectionsStore.activeSelection.kind === 'all'
    ? 'All'
    : (collectionsStore.activeCollection?.name ?? ''),
);
const scope = computed(() =>
  collectionsStore.activeSelection.kind === 'collection'
    ? collectionsStore.activeSelection.collectionId
    : '',
);

const overview = ref<DashboardOverview | null>(
  readDashboardCache(user.value?.id, scope.value),
);
const shelves = ref<DashboardShelfSummary[] | null>(
  readShelvesCache(user.value?.id),
);
const loading = ref(!overview.value);
const errorMessage = ref('');
const shelvesFailed = ref(false);
let requestNumber = 0;
let controller: AbortController | undefined;
let disposed = false;

async function loadOverview() {
  if (disposed) return;
  const request = ++requestNumber;
  controller?.abort();
  controller = new AbortController();
  // Paint this scope's last overview right away; never show another scope's.
  overview.value = readDashboardCache(user.value?.id, scope.value);
  loading.value = !overview.value;
  errorMessage.value = '';
  try {
    const response = await $fetch<{ success: true; data: DashboardOverview }>(
      '/api/dashboard/overview',
      {
        query: { collectionId: scope.value },
        signal: controller.signal,
      },
    );
    if (request !== requestNumber) return;
    overview.value = response.data;
    primeBookPreviews(response.data.lists.reading);
    writeDashboardCache(user.value?.id, scope.value, response.data);
  } catch {
    if (request !== requestNumber) return;
    errorMessage.value = 'Could not load your dashboard. Please try again.';
  } finally {
    if (request === requestNumber) loading.value = false;
  }
}

async function loadShelves() {
  shelvesFailed.value = false;
  try {
    const response = await $fetch<{
      data: { shelves: DashboardShelfSummary[] };
    }>('/api/shelves', { query: { previews: 25 } });
    if (disposed) return;
    shelves.value = response.data.shelves;
    writeShelvesCache(user.value?.id, response.data.shelves);
  } catch {
    if (!disposed) shelvesFailed.value = true;
  }
}

// ---- Card art ---------------------------------------------------------------
const dashboardSettings = computed(
  () => userSettingsStore.activeSettings.dashboard,
);

function artFor(listKey: string, kind: DashboardListKey | 'shelf') {
  return resolveCardArt(listKey, kind, dashboardSettings.value.cardArt);
}
function isOverridden(listKey: string) {
  return listKey in dashboardSettings.value.cardArt.overrides;
}
/** `null` clears the tile's override (the store drops null entries). */
function setArt(listKey: string, style: CardArtStyle | null) {
  void userSettingsStore.updateSettings({
    dashboard: { cardArt: { overrides: { [listKey]: style } } },
  } as unknown as Partial<BaseUserSettings>);
}

function setLibraryArt(style: LibraryArtStyle) {
  void userSettingsStore.updateSettingAtPath('dashboard.libraryArt', style);
}

// ---- Drifting wall: older covers beyond the overview's first page ----------
const moreRecent = ref<DashboardBook[]>([]);
const wallBooks = computed(() => [
  ...(overview.value?.recent ?? []),
  ...moreRecent.value,
]);
let moreRequest = 0;
let loadingMore = false;

async function loadMoreRecent() {
  const total = overview.value?.counts.total ?? 0;
  const offset = wallBooks.value.length;
  if (loadingMore || disposed || offset >= total) return;
  loadingMore = true;
  const request = ++moreRequest;
  try {
    const response = await $fetch<{
      data: { books: DashboardBook[]; nextOffset: number | null };
    }>('/api/dashboard/recent', {
      query: { collectionId: scope.value, offset },
    });
    if (request !== moreRequest) return;
    moreRecent.value = [...moreRecent.value, ...response.data.books];
  } catch {
    // The wall keeps looping the covers it has; the next row asks again.
  } finally {
    if (request === moreRequest) loadingMore = false;
  }
}

// ---- Lists -----------------------------------------------------------------
function readDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
}

function statusLine(key: DashboardListKey, books: DashboardBook[]) {
  const first = books[0];
  switch (key) {
    case 'reading':
      return first ? `Now: ${first.title}` : 'Nothing in progress';
    case 'to_be_read':
      return first ? `Next: ${first.title}` : 'Queue is empty';
    case 'finished':
      if (!first) return 'None yet';
      return first.finishedDate
        ? `Latest ${readDate(first.finishedDate)}`
        : `Latest: ${first.title}`;
    case 'dnf':
      return first ? 'Set aside' : 'Nothing set aside';
    case 'none':
      return first ? 'Needs a status' : 'All sorted';
  }
}

const statusTiles = computed(() =>
  STATUS_ORDER.map((key) => {
    const books = overview.value?.lists[key] ?? [];
    return {
      key,
      title: STATUS_LABELS[key],
      count: overview.value?.counts[key] ?? 0,
      books,
      line: overview.value ? statusLine(key, books) : '',
      to: key === 'to_be_read' ? '/to-be-read' : `/books?status=${key}`,
      tone: `var(--dash-s-${key})`,
    };
  }),
);

const shelfTiles = computed(() =>
  (shelves.value ?? []).map((shelf) => ({
    key: `shelf:${shelf.id}`,
    title: shelf.name,
    count: shelf.count,
    // Shelf previews don't say whether a cover exists; the cover falls back on error.
    books: shelf.previews.map((book) => ({
      id: book.id,
      title: book.title,
      spineRevision: book.spineRevision,
    })),
    line: 'Personal shelf',
    to: `/shelves/${encodeURIComponent(shelf.id)}`,
  })),
);

const continueReading = computed(
  () => overview.value?.lists.reading.slice(0, 3) ?? [],
);

/** A status change from a Continue reading cover moves the book between lists. */
function onStatusChange(change: BookStatusChange) {
  const current = overview.value?.lists.reading.find(
    (book) => book.id === change.bookId,
  );
  if (current && change.status === 'reading') return;
  void loadOverview();
}

watch(scope, () => {
  // Older covers belong to the previous collection.
  ++moreRequest;
  loadingMore = false;
  moreRecent.value = [];
  void loadOverview();
});
onMounted(() => {
  // Fire collections and dashboard in parallel; if fetchCollections()
  // reconciles activeSelection, the scope watcher re-fetches.
  if (!collectionsStore.collections.length)
    void collectionsStore.fetchCollections();
  void loadOverview();
  void loadShelves();
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
      <main class="dashboard" :aria-busy="loading">
        <header class="dashboard-greeting">
          <h1>Hello, {{ displayName }}.</h1>
          <p>
            Collection: <span>{{ collectionName }}</span>
          </p>
        </header>

        <DashboardLibraryCard
          :counts="overview?.counts ?? null"
          :recent="wallBooks"
          :show-status-bar="dashboardSettings.showStatusBar"
          :library-art="dashboardSettings.libraryArt"
          :wall-motion="dashboardSettings.wallMotion"
          @set-art="setLibraryArt"
          @need-more="loadMoreRecent"
        />

        <p v-if="loading" class="dashboard-message" role="status">Loading…</p>
        <div v-if="errorMessage" class="dashboard-error" role="alert">
          {{ errorMessage }}
          <button type="button" @click="loadOverview()">Retry</button>
        </div>

        <template v-if="overview && overview.counts.total > 0">
          <section
            v-if="continueReading.length"
            aria-labelledby="dash-continue"
          >
            <div class="dashboard-section-head">
              <h2 id="dash-continue">Continue reading</h2>
              <RouterLink to="/books?status=reading">View all</RouterLink>
            </div>
            <div class="dashboard-continue">
              <DashboardContinueCard
                v-for="book in continueReading"
                :key="book.id"
                :book="book"
                @status-change="onStatusChange"
              />
            </div>
          </section>

          <section aria-labelledby="dash-status">
            <div class="dashboard-section-head">
              <h2 id="dash-status">Reading status</h2>
            </div>
            <div class="dashboard-tiles">
              <DashboardListTile
                v-for="tile in statusTiles"
                :key="tile.key"
                :list-key="tile.key"
                :title="tile.title"
                :count="tile.count"
                :line="tile.line"
                :books="tile.books"
                :to="tile.to"
                :tone="tile.tone"
                tag="Status"
                :dimmed="tile.key === 'dnf'"
                :art-style="artFor(tile.key, tile.key)"
                :overridden="isOverridden(tile.key)"
                @set-art="setArt(tile.key, $event)"
              />
            </div>
          </section>
        </template>

        <section v-if="shelves || shelvesFailed" aria-labelledby="dash-shelves">
          <div class="dashboard-section-head">
            <h2 id="dash-shelves">Your shelves</h2>
            <RouterLink to="/shelves">Manage shelves</RouterLink>
          </div>
          <div
            v-if="shelvesFailed && !shelves"
            class="dashboard-error"
            role="alert"
          >
            Could not load your shelves.
            <button type="button" @click="loadShelves()">Retry</button>
          </div>
          <div class="dashboard-tiles">
            <DashboardListTile
              v-for="tile in shelfTiles"
              :key="tile.key"
              :list-key="tile.key"
              :title="tile.title"
              :count="tile.count"
              :line="tile.line"
              :books="tile.books"
              :to="tile.to"
              tone="var(--dash-s-shelf)"
              tag="Shelf"
              :art-style="artFor(tile.key, 'shelf')"
              :overridden="isOverridden(tile.key)"
              @set-art="setArt(tile.key, $event)"
            />
            <RouterLink to="/shelves" class="dashboard-new-shelf">
              <span class="dashboard-new-shelf-window" aria-hidden="true"
                ><Icon name="lucide:plus"
              /></span>
              <span class="dashboard-new-shelf-name">New shelf</span>
              <span class="dashboard-new-shelf-line"
                >Collect books across your library</span
              >
            </RouterLink>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  /* Status colors come only from the active theme, so every preset and custom theme works. */
  --dash-s-reading: var(--contrast-main-color);
  --dash-s-to_be_read: color-mix(
    in srgb,
    var(--contrast-main-color) 58%,
    var(--bg-color)
  );
  --dash-s-finished: color-mix(
    in srgb,
    var(--contrast-main-color) 30%,
    var(--contrast-sub-color)
  );
  --dash-s-dnf: var(--contrast-error-color);
  --dash-s-none: color-mix(
    in srgb,
    var(--contrast-sub-color) 45%,
    var(--bg-color)
  );
  --dash-s-shelf: var(--contrast-main-color);
  --dash-tile-bg: color-mix(in srgb, var(--sub-alt-color) 70%, var(--bg-color));
  box-sizing: border-box;
  width: min(100%, 1120px);
  margin: auto;
  padding: 40px 32px 56px;
  color: var(--contrast-text-color);
}
.dashboard-greeting {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 22px;
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
.dashboard-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin: 30px 0 12px;
}
.dashboard-section-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.dashboard-section-head a {
  font-size: 12px;
  color: var(--contrast-sub-color);
  text-decoration: none;
}
.dashboard-section-head a:hover {
  text-decoration: underline;
}

.dashboard-continue {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.dashboard-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 22px 16px;
}
.dashboard-new-shelf {
  display: block;
  color: inherit;
  text-decoration: none;
}
.dashboard-new-shelf-window {
  display: grid;
  place-items: center;
  aspect-ratio: 1 / 1;
  border-radius: 14px;
  border: 1.5px dashed color-mix(in srgb, var(--sub-color) 60%, transparent);
  color: var(--contrast-sub-color);
  font-size: 26px;
}
.dashboard-new-shelf:hover .dashboard-new-shelf-window {
  border-color: var(--contrast-sub-color);
}
.dashboard-new-shelf-name {
  display: block;
  margin-top: 10px;
  font-size: 14px;
  font-weight: 600;
}
.dashboard-new-shelf-line {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--contrast-sub-color);
}

.dashboard-message {
  font-size: 13px;
  opacity: 0.75;
  margin: 20px 0 0;
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
.dashboard a:focus-visible,
.dashboard button:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 4px;
}
@media (max-width: 700px) {
  .dashboard {
    padding: 24px 14px 40px;
  }
  .dashboard-greeting {
    display: block;
    margin-bottom: 16px;
  }
  .dashboard-greeting h1 {
    font-size: 26px;
  }
  .dashboard-greeting p {
    margin-top: 6px;
  }
  .dashboard-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px 12px;
  }
}
</style>
