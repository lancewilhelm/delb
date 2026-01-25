<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
/* eslint-disable vue/require-default-prop */
defineOptions({ name: 'BooksInfiniteGrid' });

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
  author?: string;

  publisher?: { id: string; name: string } | null;
  series?: { id: string; name: string } | null;

  coverImagePath?: string | null;
  createdAt: string | number | Date;
};

type BooksListResponse = {
  data?: {
    books?: Book[];
    nextCursor?: string | null;
  };
  success?: boolean;
  message?: string;
};

const props = withDefaults(
  defineProps<{
    /**
     * API endpoint to fetch from.
     * Must return `{ data: { books: Book[], nextCursor: string | null } }`.
     *
     * Examples:
     * - "/api/books"
     * - `/api/authors/${id}/books`
     * - `/api/publishers/${id}/books`
     */
    endpoint?: string;
    /**
     * Optional collection scope. If omitted, server returns books from all collections
     * the user is a member of.
     */
    collectionId?: string;
    /**
     * Server-side sort mode.
     * Defaults should be enforced by the server (date added desc).
     */
    sort?: 'dateAdded' | 'alphabetical' | 'publishedDate';
    /**
     * Server-side sort direction.
     * Defaults should be enforced by the server (desc for dateAdded/publishedDate, asc for alphabetical).
     */
    sortDir?: 'asc' | 'desc';
    /**
     * Prefetch distance for the infinite scroll sentinel.
     * Default matches our preferred behavior.
     */
    rootMargin?: string;
    /**
     * Additional buffer rows beyond one viewport.
     */
    bufferRows?: number;
    /**
     * Show a simple debug line with counts/cursor/limit.
     */
    debug?: boolean;

    /**
     * Phase 3: enable selection UI controls within the grid.
     * (Actions are handled by the parent page in Phase 4.)
     */
    selectionEnabled?: boolean;
  }>(),
  {
    endpoint: '/api/books',
    sort: 'dateAdded',
    sortDir: 'desc',
    rootMargin: '200px',
    bufferRows: 2,
    debug: false,
    selectionEnabled: true,
  },
);

const emit = defineEmits<{
  (e: 'error', message: string): void;
  (e: 'update:count', count: number): void;
}>();

// ------------------------------
// Selection mode (Phase 3)
// ------------------------------
const selectionStore = useBookSelectionStore();

const selectionScope = computed(() => {
  if (props.collectionId) {
    return { kind: 'collection' as const, collectionId: props.collectionId };
  }
  return { kind: 'all' as const };
});

// Keep selection store scope in sync with view scope changes
watch(
  () => selectionScope.value,
  (s) => {
    if (!props.selectionEnabled) return;
    selectionStore.resetForScope(s);
  },
  { deep: true, immediate: true },
);

// BookThumbnail sizing assumptions (current standard)
// Height is derived from 2:3 aspect ratio using the configured cover width.
const userSettingsStore = useUserSettingsStore();

const bookGridGapPx = computed<number>(() => {
  const raw = userSettingsStore.activeSettings.bookGrid?.gap;
  return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 12;
});

const gridCoverWidthPresetPx = computed<number>(() => {
  const raw = userSettingsStore.activeSettings.bookGrid?.coverWidthPresetPx;
  return Number.isFinite(raw) ? Math.max(80, Math.trunc(raw)) : 172;
});

const bookCardHeightPx = computed<number>(() => {
  // 2:3 aspect ratio => height = width * (3/2)
  const w = gridCoverWidthPresetPx.value;
  return Math.max(1, Math.trunc(w * (3 / 2)));
});

const gridStyle = computed<Record<string, string>>(() => {
  const w = gridCoverWidthPresetPx.value;
  const cols = userSettingsStore.activeSettings.bookGrid?.dynamicCoverSizing
    ? `repeat(auto-fit, minmax(${w}px, 1fr))`
    : `repeat(auto-fill, ${w}px)`;

  return {
    display: 'grid',
    gridTemplateColumns: cols,
    gap: `${bookGridGapPx.value}px`,
    alignItems: 'start',
  };
});

function clampInt(
  n: number,
  opts: { min: number; max: number; fallback: number },
) {
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, Math.trunc(n)));
}

const scrollContainerRef = ref<HTMLElement | null>(null);
const sentinelRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const containerSize = ref({ width: 0, height: 0 });
const measuredRowHeight = ref<number | null>(null);
const gridItemRefs = ref<HTMLElement[]>([]);

let measureRaf: number | null = null;
let measureTimer: number | null = null;

let resizeObserver: ResizeObserver | null = null;
const layoutKey = ref<string | null>(null);

onBeforeUpdate(() => {
  gridItemRefs.value = [];
});

function setGridItemRef(el: Element | ComponentPublicInstance | null) {
  if (!el) return;
  const resolved =
    el instanceof HTMLElement
      ? el
      : (el as ComponentPublicInstance).$el instanceof HTMLElement
        ? (el as ComponentPublicInstance).$el
        : null;
  if (!resolved) return;
  gridItemRefs.value.push(resolved);
}

function updateMeasuredRowHeight() {
  const items = gridItemRefs.value;
  if (!items.length) return;

  const rects = items.map((el) => el.getBoundingClientRect());
  const firstTop = Math.min(...rects.map((r) => r.top));
  const firstRowRects = rects.filter((r) => Math.abs(r.top - firstTop) < 1);

  if (!firstRowRects.length) return;

  const maxHeight = Math.max(...firstRowRects.map((r) => r.height));
  if (maxHeight > 0 && maxHeight !== measuredRowHeight.value) {
    measuredRowHeight.value = maxHeight;
  }
}

function scheduleRowHeightMeasure(opts: { debounceMs?: number } = {}) {
  const debounceMs = opts.debounceMs ?? 0;

  if (measureTimer !== null) {
    window.clearTimeout(measureTimer);
    measureTimer = null;
  }

  const schedule = () => {
    if (measureRaf !== null) return;
    measureRaf = requestAnimationFrame(() => {
      measureRaf = null;
      updateMeasuredRowHeight();
    });
  };

  if (debounceMs > 0) {
    measureTimer = window.setTimeout(schedule, debounceMs);
    return;
  }

  schedule();
}

function updateContainerSize() {
  const container = scrollContainerRef.value;
  if (!container) return;
  containerSize.value = {
    width: container.clientWidth,
    height: container.clientHeight,
  };
}

function onScroll() {
  const container = scrollContainerRef.value;
  if (!container) return;
  scrollTop.value = container.scrollTop;
}

const books = ref<Book[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const hasMore = computed(() => Boolean(nextCursor.value));

watch(
  () => books.value.length,
  async (n) => {
    emit('update:count', n);

    if (!n) {
      measuredRowHeight.value = null;
      return;
    }

    await nextTick();
    scheduleRowHeightMeasure();
  },
  { immediate: true, flush: 'post' },
);

const gridColumns = computed(() => {
  const w = containerSize.value.width;
  if (!w) return 1;

  const cardW = gridCoverWidthPresetPx.value;
  const gap = bookGridGapPx.value;

  return Math.max(1, Math.floor((w + gap) / (cardW + gap)));
});

const limit = computed(() => {
  const w = containerSize.value.width;
  const h = containerSize.value.height;
  if (!w || !h) return 48;

  const cols = gridColumns.value;
  const gap = bookGridGapPx.value;

  const cardH = measuredRowHeight.value ?? bookCardHeightPx.value;

  const rows = Math.max(
    1,
    Math.ceil((h + gap) / (cardH + gap)) + props.bufferRows,
  );

  return clampInt(cols * rows, { min: 1, max: 200, fallback: 48 });
});

const gridMetrics = computed(() => {
  const h = containerSize.value.height;

  const gap = bookGridGapPx.value;
  const rowHeight = (measuredRowHeight.value ?? bookCardHeightPx.value) + gap;

  const cols = gridColumns.value;
  const totalRows = books.value.length
    ? Math.ceil(books.value.length / cols)
    : 0;

  const totalHeight = totalRows > 0 ? totalRows * rowHeight - gap : 0;

  const overscan = Math.max(0, props.bufferRows);
  const viewportTop = scrollTop.value;
  const viewportBottom = viewportTop + h;

  const startRow = totalRows
    ? Math.max(0, Math.floor(viewportTop / rowHeight) - overscan)
    : 0;

  const endRow = totalRows
    ? Math.min(totalRows, Math.ceil(viewportBottom / rowHeight) + overscan)
    : 0;

  const startIndex = startRow * cols;
  const endIndex = Math.min(books.value.length, endRow * cols);

  return {
    cols,
    rowHeight,
    totalRows,
    totalHeight,
    startRow,
    endRow,
    startIndex,
    endIndex,
    offsetY: startRow * rowHeight,
  };
});

const visibleBooks = computed(() =>
  books.value.slice(gridMetrics.value.startIndex, gridMetrics.value.endIndex),
);

watch(
  () => [
    gridMetrics.value.startRow,
    gridColumns.value,
    containerSize.value.width,
  ],
  async () => {
    await nextTick();
    scheduleRowHeightMeasure({ debounceMs: 60 });
  },
  { flush: 'post' },
);

watch(
  () => [
    userSettingsStore.activeSettings.bookGrid?.showTitle,
    userSettingsStore.activeSettings.bookGrid?.showAuthors,
    userSettingsStore.activeSettings.bookGrid?.showSeries,
    userSettingsStore.activeSettings.bookGrid?.coverWidthPresetPx,
    userSettingsStore.activeSettings.bookGrid?.dynamicCoverSizing,
    userSettingsStore.activeSettings.bookGrid?.gap,
  ],
  async () => {
    await nextTick();
    scheduleRowHeightMeasure({ debounceMs: 80 });
  },
  { flush: 'post' },
);

const gridSpacerStyle = computed<Record<string, string>>(() => ({
  position: 'relative',
  height: `${gridMetrics.value.totalHeight}px`,
}));

const gridOffsetStyle = computed<Record<string, string>>(() => ({
  position: 'absolute',
  top: '0',
  left: '0',
  right: '0',
  transform: `translateY(${gridMetrics.value.offsetY}px)`,
}));

let io: IntersectionObserver | null = null;

function teardownObserver() {
  if (io) {
    io.disconnect();
    io = null;
  }
}

function setupObserver() {
  teardownObserver();

  const root = scrollContainerRef.value ?? null;
  const sentinel = sentinelRef.value;
  if (!sentinel) return;

  io = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry) return;

      if (entry.isIntersecting && hasMore.value && !loading.value) {
        void loadNextPage();
      }
    },
    {
      root,
      rootMargin: props.rootMargin,
      threshold: 0,
    },
  );

  io.observe(sentinel);
}

function reset() {
  books.value = [];
  nextCursor.value = null;
  errorMessage.value = null;

  if (scrollContainerRef.value) {
    scrollContainerRef.value.scrollTop = 0;
    scrollTop.value = 0;
  }

  // When the dataset resets (scope/sort changes), clear selection for safety.
  if (props.selectionEnabled) {
    selectionStore.clearSelection();
    selectionStore.setKnownBookIdsInScope([]);
  }
}

async function fetchPage(opts: { cursor?: string | null; append: boolean }) {
  if (loading.value) return;

  loading.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string | number> = {
      limit: limit.value,
    };
    if (props.collectionId) query.collectionId = props.collectionId;
    if (props.sort) query.sort = props.sort;
    if (props.sortDir) query.sortDir = props.sortDir;
    if (opts.cursor) query.cursor = opts.cursor;

    const res = await $fetch<BooksListResponse>(props.endpoint, {
      method: 'GET',
      query,
    });

    const page = res?.data?.books ?? [];
    const cursor = (res?.data?.nextCursor ?? null) as string | null;

    if (opts.append) {
      const seen = new Set(books.value.map((b) => b.id));
      for (const b of page) {
        if (!seen.has(b.id)) books.value.push(b);
      }
    } else {
      books.value = page;
    }

    // Track known IDs for selection UX (Phase 3).
    if (props.selectionEnabled) {
      selectionStore.addKnownBookIdsInScope(page.map((b) => b.id));
    }

    nextCursor.value = cursor;
  } catch (err) {
    const e = err as FetchErrorLike;
    const msg =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load books';
    errorMessage.value = msg;
    emit('error', msg);
  } finally {
    loading.value = false;
  }
}

async function loadFirstPage() {
  reset();
  await fetchPage({ cursor: null, append: false });

  await nextTick();
  setupObserver();
}

async function loadNextPage() {
  if (!hasMore.value) return;
  await fetchPage({ cursor: nextCursor.value, append: true });
}

// Refetch when collection scope changes / endpoint changes (new author/publisher page, etc.)
watch(
  [
    () => props.collectionId,
    () => props.endpoint,
    () => props.sort,
    () => props.sortDir,
  ],
  async () => {
    await loadFirstPage();
  },
);

// If layout changes (columns/height), restart paging to avoid mixed chunk sizes
watch(
  [() => gridColumns.value, () => containerSize.value.height],
  async ([cols, height]) => {
    if (!scrollContainerRef.value) return;
    if (!books.value.length) return;

    const key = `${cols}x${height}`;
    if (layoutKey.value === key) return;
    layoutKey.value = key;

    await loadFirstPage();
  },
  { flush: 'post' },
);

onMounted(async () => {
  await nextTick();
  updateContainerSize();
  onScroll();

  const initialKey = `${gridColumns.value}x${containerSize.value.height}`;
  layoutKey.value = initialKey;

  if (scrollContainerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      updateContainerSize();
    });
    resizeObserver.observe(scrollContainerRef.value);
  }

  window.addEventListener('resize', updateContainerSize);

  await loadFirstPage();
});

onBeforeUnmount(() => {
  teardownObserver();
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  if (measureTimer !== null) {
    window.clearTimeout(measureTimer);
    measureTimer = null;
  }
  if (measureRaf !== null) {
    cancelAnimationFrame(measureRaf);
    measureRaf = null;
  }

  window.removeEventListener('resize', updateContainerSize);
});
</script>

<template>
  <!-- This component owns the scroll container so the view selector (outside) does not scroll. -->
  <div ref="scrollContainerRef" class="flex-1 overflow-auto" @scroll="onScroll">
    <div class="px-4 py-4">
      <div v-if="errorMessage" class="text-sm text-(--error-color) mb-3">
        {{ errorMessage }}
      </div>

      <div v-if="debug" class="text-xs opacity-70 mb-3">
        books={{ books.length }} limit={{ limit }} loading={{
          loading
        }}
        hasMore={{ hasMore }} nextCursor={{ nextCursor ?? 'null' }}
      </div>

      <div v-if="loading && books.length === 0" class="text-sm opacity-80">
        Loading...
      </div>

      <div v-else-if="books.length === 0" class="text-sm opacity-80">
        No books yet. Use Upload in the header to add one.
      </div>

      <div v-else class="w-full">
        <div class="relative w-full" :style="gridSpacerStyle">
          <div class="w-full" :style="[gridStyle, gridOffsetStyle]">
            <div v-for="b in visibleBooks" :key="b.id" :ref="setGridItemRef">
              <BookThumbnail
                :book="b"
                :lock-aspect-ratio="true"
                :selectable="
                  props.selectionEnabled && selectionStore.selectMode
                "
                :selected="selectionStore.isSelected(b.id)"
                @toggle-select="selectionStore.toggle"
              />
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="books.length > 0"
        class="mt-6 flex flex-col items-center gap-2"
      >
        <div ref="sentinelRef" class="h-1 w-full" />
        <div class="text-sm opacity-70">
          <span v-if="loading">Loading…</span>
          <span v-else-if="!hasMore">No more results</span>
          <span v-else>Scroll to load more…</span>
        </div>
      </div>
    </div>
  </div>
</template>
