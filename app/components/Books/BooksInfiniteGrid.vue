<script setup lang="ts">
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
const BOOK_CARD_W_PX = 172;
const BOOK_CARD_H_PX = 310;
const BOOK_GRID_GAP_PX = 12;

function clampInt(
  n: number,
  opts: { min: number; max: number; fallback: number },
) {
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, Math.trunc(n)));
}

const scrollContainerRef = ref<HTMLElement | null>(null);
const sentinelRef = ref<HTMLElement | null>(null);

const books = ref<Book[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const hasMore = computed(() => Boolean(nextCursor.value));

watch(
  () => books.value.length,
  (n) => {
    emit('update:count', n);
  },
  { immediate: true },
);

const limit = computed(() => {
  const container = scrollContainerRef.value;
  if (!container) return 48;

  const w = container.clientWidth;
  const h = container.clientHeight;

  const cols = Math.max(
    1,
    Math.floor((w + BOOK_GRID_GAP_PX) / (BOOK_CARD_W_PX + BOOK_GRID_GAP_PX)),
  );

  const rows = Math.max(
    1,
    Math.ceil((h + BOOK_GRID_GAP_PX) / (BOOK_CARD_H_PX + BOOK_GRID_GAP_PX)) +
      props.bufferRows,
  );

  return clampInt(cols * rows, { min: 1, max: 200, fallback: 48 });
});

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

// If limit changes (resize/layout), restart paging to avoid mixed chunk sizes
watch(
  () => limit.value,
  async () => {
    // Only act once mounted and when we have a real container size
    if (!scrollContainerRef.value) return;
    await loadFirstPage();
  },
);

onMounted(async () => {
  await loadFirstPage();
});

onBeforeUnmount(() => {
  teardownObserver();
});
</script>

<template>
  <!-- This component owns the scroll container so the view selector (outside) does not scroll. -->
  <div ref="scrollContainerRef" class="flex-1 overflow-auto">
    <div class="px-4 py-4">
      <div v-if="errorMessage" class="text-sm text-red-600 mb-3">
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

      <div v-else class="flex gap-3 flex-wrap">
        <BookThumbnail
          v-for="b in books"
          :key="b.id"
          :book="b"
          :lock-aspect-ratio="true"
          :selectable="props.selectionEnabled && selectionStore.selectMode"
          :selected="selectionStore.isSelected(b.id)"
          @toggle-select="selectionStore.toggle"
        />
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
