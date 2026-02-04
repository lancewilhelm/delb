<script setup lang="ts">
/* eslint-disable vue/require-default-prop */
defineOptions({ name: 'BooksInfiniteList' });

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
  seriesIndex?: number | null;

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
     * Enable selection UI controls within the list.
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
// Selection mode
// ------------------------------
const selectionStore = useBookSelectionStore();
const lastRangeAnchorId = ref<string | null>(null);

const selectionScope = computed(() => {
  if (props.collectionId) {
    return { kind: 'collection' as const, collectionId: props.collectionId };
  }
  return { kind: 'all' as const };
});

watch(
  () => selectionScope.value,
  (s) => {
    if (!props.selectionEnabled) return;
    selectionStore.resetForScope(s);
    lastRangeAnchorId.value = null;
  },
  { deep: true, immediate: true },
);

watch(
  () => selectionStore.selectMode,
  (enabled) => {
    if (!enabled) lastRangeAnchorId.value = null;
  },
);

const userSettingsStore = useUserSettingsStore();

function clampInt(
  n: number,
  opts: { min: number; max: number; fallback: number },
) {
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, Math.trunc(n)));
}

const listRowHeightPx = computed<number>(() => {
  const raw = userSettingsStore.activeSettings.bookList?.rowHeightPx;
  return clampInt(Number(raw), { min: 40, max: 220, fallback: 84 });
});

const listRowGapPx = 0;

const rowPaddingY = 6;
const rowPaddingX = 10;

const headerCoverHeightPx = computed(() =>
  Math.max(24, listRowHeightPx.value - rowPaddingY * 2),
);

const headerCoverWidthPx = computed(() =>
  Math.max(16, Math.round(headerCoverHeightPx.value * (2 / 3))),
);

const headerPaddingStyle = computed<Record<string, string>>(() => ({
  padding: `${rowPaddingY}px ${rowPaddingX}px`,
}));

const headerCoverStyle = computed<Record<string, string>>(() => ({
  width: `${headerCoverWidthPx.value}px`,
}));

const headerColumnStyles = {
  title: { flex: '2 1 0%', minWidth: '0' },
  authors: { flex: '1.5 1 0%', minWidth: '0' },
  series: { flex: '1 1 0%', minWidth: '0' },
};

const scrollContainerRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const sentinelRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const containerSize = ref({ width: 0, height: 0 });

let resizeObserver: ResizeObserver | null = null;
const layoutKey = ref<string | null>(null);

function updateContainerSize() {
  const container = scrollContainerRef.value;
  if (!container) return;
  let width = container.clientWidth;
  const content = contentRef.value;
  if (content) {
    const style = window.getComputedStyle(content);
    const left = Number.parseFloat(style.paddingLeft || '0') || 0;
    const right = Number.parseFloat(style.paddingRight || '0') || 0;
    const next = content.clientWidth - left - right;
    width = Number.isFinite(next) ? Math.max(0, next) : width;
  }
  containerSize.value = {
    width,
    height: container.clientHeight,
  };
}

function onScroll() {
  const container = scrollContainerRef.value;
  if (!container) return;
  scrollTop.value = container.scrollTop;
}

function getBookIndex(bookId: string) {
  return books.value.findIndex((b) => b.id === bookId);
}

function onBookToggleSelect(bookId: string, meta?: { shiftKey?: boolean }) {
  if (!props.selectionEnabled) return;

  const isShift = Boolean(meta?.shiftKey);
  const anchorId = lastRangeAnchorId.value;

  if (!isShift || !anchorId) {
    selectionStore.toggle(bookId);
    lastRangeAnchorId.value = bookId;
    return;
  }

  const anchorIndex = getBookIndex(anchorId);
  const targetIndex = getBookIndex(bookId);

  if (anchorIndex < 0 || targetIndex < 0) {
    selectionStore.toggle(bookId);
    lastRangeAnchorId.value = bookId;
    return;
  }

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const ids = books.value.slice(start, end + 1).map((b) => b.id);
  const shouldSelect = !selectionStore.isSelected(bookId);

  selectionStore.applySelectionRange(ids, shouldSelect);
  lastRangeAnchorId.value = bookId;
}

const books = ref<Book[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const hasMore = computed(() => Boolean(nextCursor.value));

function debugLog(message: string, data?: Record<string, unknown>) {
  if (!props.debug) return;
  if (data) {
    console.debug('[BooksInfiniteList]', message, data);
    return;
  }
  console.debug('[BooksInfiniteList]', message);
}

watch(
  () => books.value.length,
  (n) => {
    emit('update:count', n);
  },
  { immediate: true, flush: 'post' },
);

const limit = computed(() => {
  const h = containerSize.value.height;
  const row = listRowHeightPx.value;
  const gap = listRowGapPx;
  if (!h || !row) return 48;

  const rows = Math.max(
    1,
    Math.ceil((h + gap) / (row + gap)) + Math.max(0, props.bufferRows),
  );

  return clampInt(rows, { min: 1, max: 200, fallback: 48 });
});

const listMetrics = computed(() => {
  const h = containerSize.value.height;
  const row = listRowHeightPx.value;
  const gap = listRowGapPx;
  const rowHeight = row + gap;

  const totalRows = books.value.length;
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

  const startIndex = startRow;
  const endIndex = Math.min(books.value.length, endRow);

  return {
    rowHeight,
    totalRows,
    totalHeight,
    startIndex,
    endIndex,
    offsetY: startRow * rowHeight,
  };
});

const listSpacerStyle = computed<Record<string, string>>(() => ({
  position: 'relative',
  height: `${listMetrics.value.totalHeight}px`,
}));

const listOffsetStyle = computed<Record<string, string>>(() => ({
  position: 'absolute',
  top: '0',
  left: '0',
  right: '0',
  transform: `translateY(${listMetrics.value.offsetY}px)`,
  display: 'flex',
  flexDirection: 'column',
}));

const visibleBooks = computed(() =>
  books.value.slice(listMetrics.value.startIndex, listMetrics.value.endIndex),
);

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
  lastRangeAnchorId.value = null;

  if (scrollContainerRef.value) {
    scrollContainerRef.value.scrollTop = 0;
    scrollTop.value = 0;
  }

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
    debugLog('fetchPage:start', {
      append: opts.append,
      cursor: opts.cursor ?? null,
      limit: limit.value,
      current: books.value.length,
    });

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

    if (props.selectionEnabled) {
      selectionStore.addKnownBookIdsInScope(page.map((b) => b.id));
    }

    nextCursor.value = cursor;

    debugLog('fetchPage:done', {
      received: page.length,
      total: books.value.length,
      nextCursor: cursor,
    });
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

watch(
  [() => listRowHeightPx.value, () => containerSize.value.height],
  async ([rowHeight, height]) => {
    if (!scrollContainerRef.value) return;
    if (!books.value.length) return;

    const key = `${rowHeight}x${height}`;
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

  const initialKey = `${listRowHeightPx.value}x${containerSize.value.height}`;
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

  window.removeEventListener('resize', updateContainerSize);
});
</script>

<template>
  <!-- This component owns the scroll container so the view selector (outside) does not scroll. -->
  <div
    ref="scrollContainerRef"
    class="flex-1 overflow-auto [overflow-anchor:none]"
    @scroll="onScroll"
  >
    <div ref="contentRef" class="px-4 py-4">
      <div v-if="errorMessage" class="text-sm text-(--error-color) mb-3">
        {{ errorMessage }}
      </div>

      <div v-if="debug" class="text-xs opacity-70 mb-3">
        books={{ books.length }} limit={{ limit }} row={{
          listRowHeightPx
        }}
        range={{ listMetrics.startIndex }}-{{ listMetrics.endIndex }} scroll={{
          Math.round(scrollTop)
        }}
        total={{ Math.round(listMetrics.totalHeight) }} loading={{ loading }}
        hasMore={{ hasMore }} nextCursor={{ nextCursor ?? 'null' }}
      </div>

      <div v-if="loading && books.length === 0" class="text-sm opacity-80">
        Loading...
      </div>

      <div v-else-if="books.length === 0" class="text-sm opacity-80">
        No books yet. Use Upload in the header to add one.
      </div>

      <div v-else class="w-full">
        <div
          class="sticky top-0 z-10 bg-(--bg-color) border-b border-(--sub-color)/50"
        >
          <div class="flex items-center gap-4 w-full" :style="headerPaddingStyle">
            <div class="shrink-0 text-xs uppercase tracking-wide opacity-70" :style="headerCoverStyle">
              Cover
            </div>
            <div
              class="text-xs uppercase tracking-wide opacity-70"
              :style="headerColumnStyles.title"
            >
              Title
            </div>
            <div
              class="text-xs uppercase tracking-wide opacity-70"
              :style="headerColumnStyles.authors"
            >
              Authors
            </div>
            <div
              class="text-xs uppercase tracking-wide opacity-70"
              :style="headerColumnStyles.series"
            >
              Series
            </div>
          </div>
        </div>

        <div class="relative w-full" :style="listSpacerStyle">
          <div class="w-full" :style="listOffsetStyle">
            <BooksListRow
              v-for="b in visibleBooks"
              :key="b.id"
              :book="b"
              :row-height-px="listRowHeightPx"
              :selectable="
                props.selectionEnabled && selectionStore.selectMode
              "
              :selected="selectionStore.isSelected(b.id)"
              @toggle-select="onBookToggleSelect"
            />
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
