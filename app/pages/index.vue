<script setup lang="ts">
import { useAuth } from '~/composables/useAuth';
import { useHead } from '~/composables/useHead';
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
  holdPile,
  pileSampleSize,
  resolveCardArt,
  type CardArtStyle,
  type HeldPile,
  type LibraryArtStyle,
} from '~/utils/dashboardArt';
import type {
  DashboardBook,
  DashboardListKey,
  DashboardOverview,
} from '#shared/types/dashboard';
useHead({ title: 'Dashboard' });

const userSettingsStore = useUserSettingsStore();
const { user } = useAuth();
const displayName = computed(() => user.value?.name?.trim() || 'there');

const overview = ref<DashboardOverview | null>(
  readDashboardCache(user.value?.id),
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
  // Paint this user's last overview right away while fresh data loads.
  overview.value = readDashboardCache(user.value?.id);
  loading.value = !overview.value;
  errorMessage.value = '';
  try {
    const response = await $fetch<{ success: true; data: DashboardOverview }>(
      '/api/dashboard/overview',
      {
        query: pileSize.value === 'auto' ? {} : { pile: pileSize.value },
        signal: controller.signal,
      },
    );
    if (request !== requestNumber) return;
    overview.value = response.data;
    primeBookPreviews(response.data.lists.reading);
    writeDashboardCache(user.value?.id, response.data);
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
    }>('/api/shelves', {
      query: { previews: 25, pile: pileSampleSize(pileSize.value, false) },
    });
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

// ---- Piles: a random sample per list, held for the page's lifetime ---------
const pileSize = computed(() => dashboardSettings.value.pileSize);
type PileBook = DashboardShelfSummary['previews'][number] | DashboardBook;
/** Keyed like card art overrides (`all`, `reading`, `shelf:<id>`, …). */
const piles = ref<Record<string, HeldPile<PileBook>>>({});

/**
 * A pile from a response: its sample when that has the size the reader asked
 * for, and otherwise no books yet, so the pile drops in once when a fitting
 * sample arrives instead of twice.
 */
function pileFrom(
  sample: PileBook[] | undefined,
  count: number,
  library: boolean,
): HeldPile<PileBook> {
  const fits =
    !!sample &&
    sample.length === Math.min(count, pileSampleSize(pileSize.value, library));
  return { count, random: fits, books: fits ? sample : [] };
}

/** Adopts fresh samples, keeping the books each pile already shows. */
function holdPiles(next: Record<string, HeldPile<PileBook>>) {
  const held = { ...piles.value };
  for (const [key, pile] of Object.entries(next))
    held[key] = holdPile(held[key], pile);
  piles.value = held;
}

watch(
  overview,
  (data) => {
    if (!data) return;
    const next: Record<string, HeldPile<PileBook>> = {
      all: pileFrom(data.piles?.all, data.counts.total, true),
    };
    for (const key of STATUS_ORDER)
      next[key] = pileFrom(data.piles?.[key], data.counts[key], false);
    holdPiles(next);
  },
  { immediate: true },
);

watch(
  shelves,
  (list) => {
    if (!list) return;
    holdPiles(
      Object.fromEntries(
        list.map((shelf) => [
          `shelf:${shelf.id}`,
          pileFrom(shelf.pile ?? [], shelf.count, false),
        ]),
      ),
    );
  },
  { immediate: true },
);

// A new pile size needs new samples.
watch(pileSize, () => {
  piles.value = {};
  void loadOverview();
  void loadShelves();
});

// ---- Drifting wall: older covers beyond the overview's first page ----------
const moreRecent = ref<DashboardBook[]>([]);
const wallBooks = computed(() => [
  ...(overview.value?.recent ?? []),
  ...moreRecent.value,
]);
let moreRequest = 0;
let loadingMore = false;

async function loadMoreRecent() {
  if (shelfUsesSpines.value) return loadMoreSpines();
  const total = overview.value?.counts.total ?? 0;
  const offset = wallBooks.value.length;
  if (loadingMore || disposed || offset >= total) return;
  loadingMore = true;
  const request = ++moreRequest;
  try {
    const response = await $fetch<{
      data: { books: DashboardBook[]; nextOffset: number | null };
    }>('/api/dashboard/recent', {
      query: { offset },
    });
    if (request !== moreRequest) return;
    moreRecent.value = [...moreRecent.value, ...response.data.books];
  } catch {
    // The wall keeps looping the covers it has; the next row asks again.
  } finally {
    if (request === moreRequest) loadingMore = false;
  }
}

// ---- Shelf: every book, or only books with spine art ----------------------
const shelfUsesSpines = computed(
  () =>
    dashboardSettings.value.libraryArt === 'shelf' &&
    dashboardSettings.value.shelfSpinesOnly,
);
const spineBooks = ref<DashboardBook[]>([]);
const spinesComplete = ref(false);
let spineRequest = 0;
let loadingSpines = false;

async function loadMoreSpines() {
  if (loadingSpines || disposed || spinesComplete.value) return;
  loadingSpines = true;
  const request = ++spineRequest;
  try {
    const response = await $fetch<{
      data: { books: DashboardBook[]; nextOffset: number | null };
    }>('/api/dashboard/recent', {
      query: {
        offset: spineBooks.value.length,
        spines: 1,
      },
    });
    if (request !== spineRequest) return;
    spineBooks.value = [...spineBooks.value, ...response.data.books];
    spinesComplete.value = response.data.nextOffset === null;
  } catch {
    // The shelf keeps the spines it has; the next request tries again.
  } finally {
    if (request === spineRequest) loadingSpines = false;
  }
}

const shelfBooks = computed(() =>
  shelfUsesSpines.value ? spineBooks.value : wallBooks.value,
);
const shelfComplete = computed(() =>
  shelfUsesSpines.value
    ? spinesComplete.value
    : wallBooks.value.length >= (overview.value?.counts.total ?? 0),
);
watch(
  shelfUsesSpines,
  (on) => {
    if (on && !spineBooks.value.length) void loadMoreSpines();
  },
  { immediate: true },
);

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
      pileBooks: piles.value[key]?.books,
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
    books: shelf.previews,
    pileBooks: piles.value[`shelf:${shelf.id}`]?.books,
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

onMounted(() => {
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
        <ViewSelectorDropdown class="justify-center" />
      </div>
    </div>
    <div class="flex-1 min-h-0 overflow-auto">
      <main class="dashboard" :aria-busy="loading">
        <header class="dashboard-greeting">
          <h1>Hello, {{ displayName }}.</h1>
        </header>

        <DashboardLibraryCard
          :counts="overview?.counts ?? null"
          :recent="wallBooks"
          :initial-cover-count="overview?.recent.length ?? 0"
          :pile-books="piles.all?.books ?? []"
          :pile-size="dashboardSettings.pileSize"
          :shelf-books="shelfBooks"
          :shelf-complete="shelfComplete"
          :shelf-spines-only="dashboardSettings.shelfSpinesOnly"
          :show-status-bar="dashboardSettings.showStatusBar"
          :library-art="dashboardSettings.libraryArt"
          :wall-motion="dashboardSettings.wallMotion"
          :wall-drift-speed="dashboardSettings.wallDriftSpeed"
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
                :pile-books="tile.pileBooks"
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
              :pile-books="tile.pileBooks"
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
  .dashboard-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px 12px;
  }
}
</style>
