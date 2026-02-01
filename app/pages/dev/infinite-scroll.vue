<script setup lang="ts">
definePageMeta({
  auth: { only: 'user', redirectGuestTo: '/login' },
});

useHead({ title: 'Dev: Infinite Scroll' });

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type Book = {
  id: string;
  title: string;
  authors?: { id: string; name: string }[];
  authorNames?: string[];
  author?: string; // back-compat
  publisher?: { id: string; name: string } | null;
  series?: { id: string; name: string } | null;
  coverImagePath?: string | null;
  createdAt: string | number | Date;
  updatedAt?: string | number | Date;
};

type BooksListResponse = {
  data?: {
    books?: Book[];
    nextCursor?: string | null;
  };
  success?: boolean;
  message?: string;
};

const collectionsStore = useCollectionsStore();

/**
 * Incremental test modes:
 * - "single": fetch first page only
 * - "manual": fetch first page + "Load more" button
 * - "observer": IntersectionObserver sentinel autoload
 */
const mode = ref<'single' | 'manual' | 'observer'>('observer');

/**
 * Limit mode:
 * - "fixed": use `fixedLimit`
 * - "auto": compute from known BookThumbnail dimensions + container size (with buffer rows)
 */
const limitMode = ref<'fixed' | 'auto'>('fixed');

// Parameters you can tweak
const fixedLimit = ref<number>(3);
const rootMargin = ref<string>('200px');
const threshold = ref<number>(0);
const showDebug = ref<boolean>(true);

// Auto limit tuning
const bufferRows = ref<number>(2);

/**
 * BookThumbnail card sizing (current standard):
 * - width: 172px
 * - height: 310px
 * Grid uses `gap-3` which is 0.75rem => 12px (Tailwind default).
 */
const cardWidthPx = 172;
const cardHeightPx = 310;
const gapPx = 12;

const books = ref<Book[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const hasMore = computed(() => Boolean(nextCursor.value));

const collectionId = computed<string | undefined>(() => {
  if (
    collectionsStore.activeSelection.kind === 'collection' &&
    collectionsStore.activeSelection.collectionId
  ) {
    return collectionsStore.activeSelection.collectionId;
  }
  return undefined;
});

// Scroll container + sentinel for observer mode
const scrollContainerRef = ref<HTMLElement | null>(null);
const sentinelRef = ref<HTMLElement | null>(null);

// No DOM measurement needed: we rely on fixed BookThumbnail dimensions.

let io: IntersectionObserver | null = null;

function reset() {
  books.value = [];
  nextCursor.value = null;
  errorMessage.value = null;
}

function clampInt(n: number, opts: { min: number; max: number }) {
  if (!Number.isFinite(n)) return opts.min;
  return Math.max(opts.min, Math.min(opts.max, Math.trunc(n)));
}

const autoLimit = computed(() => {
  if (limitMode.value !== 'auto') return null;

  const container = scrollContainerRef.value;
  if (!container) return null;

  const containerW = container.clientWidth;
  const containerH = container.clientHeight;

  // Columns: how many cards can fit across (including gap)
  const cols = Math.max(
    1,
    Math.floor((containerW + gapPx) / (cardWidthPx + gapPx)),
  );

  // Rows: how many cards fit vertically, plus buffer rows
  const rows = Math.max(
    1,
    Math.ceil((containerH + gapPx) / (cardHeightPx + gapPx)) + bufferRows.value,
  );

  return clampInt(cols * rows, { min: 1, max: 200 });
});

const effectiveLimit = computed(() => {
  if (limitMode.value === 'auto') return autoLimit.value ?? fixedLimit.value;
  return fixedLimit.value;
});

async function fetchPage(opts?: { cursor?: string | null; append?: boolean }) {
  if (loading.value) return;
  loading.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string | number> = {
      limit: effectiveLimit.value,
    };

    if (collectionId.value) query.collectionId = collectionId.value;
    if (opts?.cursor) query.cursor = opts.cursor;

    const res = await $fetch<BooksListResponse>('/api/books', {
      method: 'GET',
      query,
    });

    const page = res?.data?.books ?? [];
    const cursor = (res?.data?.nextCursor ?? null) as string | null;

    if (opts?.append) {
      // Safety: basic de-dupe by id to avoid accidental duplicates
      const seen = new Set(books.value.map((b) => b.id));
      for (const b of page) {
        if (!seen.has(b.id)) books.value.push(b);
      }
    } else {
      books.value = page;
    }

    nextCursor.value = cursor;
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load books';
  } finally {
    loading.value = false;
  }
}

async function loadFirstPage() {
  reset();
  await fetchPage({ cursor: null, append: false });
}

async function loadNextPage() {
  if (!hasMore.value) return;
  await fetchPage({ cursor: nextCursor.value, append: true });
}

function teardownObserver() {
  if (io) {
    io.disconnect();
    io = null;
  }
}

function setupObserver() {
  teardownObserver();

  // Only in observer mode
  if (mode.value !== 'observer') return;

  // If refs aren't ready yet, bail; a watcher below will re-run setup.
  const root = scrollContainerRef.value ?? null;
  const sentinel = sentinelRef.value;
  if (!sentinel) return;

  io = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry) return;

      // Avoid overlapping loads + only load when we have more
      if (entry.isIntersecting && hasMore.value && !loading.value) {
        void loadNextPage();
      }
    },
    {
      root,
      rootMargin: rootMargin.value,
      threshold: threshold.value,
    },
  );

  io.observe(sentinel);
}

// Re-fetch when scope changes
watch(
  () => collectionId.value,
  async () => {
    await loadFirstPage();
  },
);

// Re-create observer when config/mode changes OR when `hasMore` flips (end reached).
watch(
  [
    () => mode.value,
    () => rootMargin.value,
    () => threshold.value,
    () => hasMore.value,
  ],
  async () => {
    // If we leave observer mode, disconnect immediately.
    if (mode.value !== 'observer') {
      teardownObserver();
      return;
    }

    // Ensure we have some data loaded when entering observer mode
    if (!books.value.length) {
      await loadFirstPage();
    }

    await nextTick();
    setupObserver();
  },
  { flush: 'post' },
);

// When auto-limit relevant inputs change, reset paging (safe and predictable).
watch(
  [() => limitMode.value, () => bufferRows.value, () => effectiveLimit.value],
  async () => {
    if (limitMode.value !== 'auto') return;

    // Reset paging when auto limit changes to avoid mixed page sizes.
    await loadFirstPage();
  },
  { flush: 'post' },
);

// Also respond to sentinel/container being mounted
onMounted(async () => {
  await loadFirstPage();
  await nextTick();
  setupObserver();
});

onBeforeUnmount(() => {
  teardownObserver();
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="p-4 border-b border-base-300">
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col">
          <h1 class="text-lg font-semibold">Dev: Infinite Scroll</h1>
          <p class="text-sm opacity-70">
            Incremental harness for /api/books cursor pagination + infinite
            scroll.
          </p>
        </div>

        <div class="flex items-center gap-2">
          <button class="btn btn-sm" :disabled="loading" @click="loadFirstPage">
            Reload
          </button>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <label class="form-control">
          <div class="label">
            <span class="label-text">Mode</span>
          </div>
          <select v-model="mode" class="select select-bordered select-sm">
            <option value="single">single page (no append)</option>
            <option value="manual">manual (Load more button)</option>
            <option value="observer">
              observer (sentinel infinite scroll)
            </option>
          </select>
        </label>

        <label class="form-control">
          <div class="label">
            <span class="label-text">Limit mode</span>
          </div>
          <select v-model="limitMode" class="select select-bordered select-sm">
            <option value="fixed">fixed</option>
            <option value="auto">auto (measure card)</option>
          </select>
        </label>

        <label class="form-control">
          <div class="label">
            <span class="label-text">
              Limit
              <span v-if="limitMode === 'auto'" class="opacity-60">
                (effective: {{ effectiveLimit }})
              </span>
            </span>
          </div>
          <input
            v-model.number="fixedLimit"
            class="input input-bordered input-sm"
            type="number"
            min="1"
            max="200"
            :disabled="limitMode === 'auto'"
          />
        </label>

        <label class="form-control">
          <div class="label">
            <span class="label-text">Debug UI</span>
          </div>
          <label class="label cursor-pointer justify-start gap-3">
            <input
              v-model="showDebug"
              type="checkbox"
              class="toggle toggle-sm"
            />
            <span class="label-text">Show debug panel</span>
          </label>
        </label>
      </div>

      <div
        v-if="limitMode === 'auto'"
        class="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3"
      >
        <label class="form-control">
          <div class="label">
            <span class="label-text">Buffer rows</span>
          </div>
          <input
            v-model.number="bufferRows"
            class="input input-bordered input-sm"
            type="number"
            min="0"
            max="10"
          />
        </label>

        <div class="form-control">
          <div class="label">
            <span class="label-text">Card size</span>
          </div>
          <div class="text-sm opacity-70">
            {{ cardWidthPx }}×{{ cardHeightPx }} px
          </div>
        </div>

        <div class="form-control">
          <div class="label">
            <span class="label-text">Gap</span>
          </div>
          <div class="text-sm opacity-70">{{ gapPx }} px</div>
        </div>
      </div>

      <div
        v-if="mode === 'observer'"
        class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3"
      >
        <label class="form-control">
          <div class="label">
            <span class="label-text">rootMargin</span>
          </div>
          <input
            v-model="rootMargin"
            class="input input-bordered input-sm"
            type="text"
          />
          <div class="label">
            <span class="label-text-alt"
              >Example: 800px (preload before bottom)</span
            >
          </div>
        </label>

        <label class="form-control">
          <div class="label">
            <span class="label-text">threshold</span>
          </div>
          <input
            v-model.number="threshold"
            class="input input-bordered input-sm"
            type="number"
            min="0"
            max="1"
            step="0.05"
          />
        </label>
      </div>

      <div v-if="errorMessage" class="alert alert-error mt-4">
        <span>{{ errorMessage }}</span>
      </div>

      <div v-if="showDebug" class="mt-4 text-sm">
        <div class="flex flex-wrap gap-x-6 gap-y-1">
          <div>
            <span class="opacity-70">books:</span>
            {{ books.length }}
          </div>
          <div><span class="opacity-70">loading:</span> {{ loading }}</div>
          <div><span class="opacity-70">hasMore:</span> {{ hasMore }}</div>
          <div>
            <span class="opacity-70">nextCursor:</span>
            {{ nextCursor ?? 'null' }}
          </div>
          <div>
            <span class="opacity-70">collectionId:</span>
            {{ collectionId ?? 'all' }}
          </div>
          <div>
            <span class="opacity-70">limitMode:</span>
            {{ limitMode }}
          </div>
          <div>
            <span class="opacity-70">effectiveLimit:</span>
            {{ effectiveLimit }}
          </div>
        </div>
      </div>
    </div>

    <!-- This container is the observer root (scrollable) to make behavior consistent regardless of app layout -->
    <div ref="scrollContainerRef" class="flex-1 overflow-auto">
      <div class="p-4">
        <!-- Keep rendering identical to the production grid as much as possible -->
        <div
          class="flex gap-3 flex-wrap"
          :style="{
            gridTemplateColumns: 'repeat(auto-fill, minmax(172px, 1fr))',
          }"
        >
          <BookThumbnail
            v-for="b in books"
            :key="b.id"
            :book="b"
            :lock-aspect-ratio="true"
          />
        </div>

        <!-- Manual mode button -->
        <div v-if="mode === 'manual'" class="mt-6 flex justify-center">
          <button
            class="btn"
            :disabled="loading || !hasMore"
            @click="loadNextPage"
          >
            <span v-if="loading" class="loading loading-spinner loading-sm" />
            <span v-else>Load more</span>
          </button>
        </div>

        <!-- Observer sentinel -->
        <div
          v-if="mode === 'observer'"
          class="mt-6 flex flex-col items-center gap-2"
        >
          <div ref="sentinelRef" class="h-1 w-full" />
          <div class="text-sm opacity-70">
            <span v-if="loading">Loading…</span>
            <span v-else-if="!hasMore">No more results</span>
            <span v-else>Scroll to load more…</span>
          </div>
        </div>

        <!-- Single page mode helper -->
        <div
          v-if="mode === 'single'"
          class="mt-6 text-center text-sm opacity-70"
        >
          Single page mode: not appending results.
        </div>
      </div>
    </div>
  </div>
</template>
