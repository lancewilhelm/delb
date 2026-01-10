<script setup lang="ts">
type SearchKind = 'book' | 'author' | 'series' | 'publisher' | 'tag';

type GlobalSearchResultItem = {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string | null;
  icon?: string;
  coverImagePath?: string | null;
};

type GroupedResults = {
  kind: SearchKind;
  label: string;
  items: GlobalSearchResultItem[];
};

type SearchApiBucketRow = {
  id: string;
  name?: string;
  title?: string;
  subtitle?: string | null;
};

type SearchApiResponse = {
  success: boolean;
  data?: {
    q: string;
    perBucketLimit: number;
    buckets: {
      books: Array<{
        id: string;
        title: string;
        subtitle?: string | null;
        published?: string | null;
        coverImagePath?: string | null;
      }>;
      authors: SearchApiBucketRow[];
      series: SearchApiBucketRow[];
      publishers: SearchApiBucketRow[];
      tags: SearchApiBucketRow[];
    };
  };
};

const uiStore = useUiStore();

const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const optionsRef = ref<HTMLDivElement | null>(null);

const loading = ref(false);
const errorMessage = ref<string | null>(null);

function toggleModal() {
  uiStore.setGlobalSearchVisible(!uiStore.globalSearchVisible);
  if (uiStore.globalSearchVisible) {
    nextTick(() => inputRef.value?.focus());
  }
}

const results = ref<GroupedResults[]>([
  { kind: 'book', label: 'Books', items: [] },
  { kind: 'author', label: 'Authors', items: [] },
  { kind: 'series', label: 'Series', items: [] },
  { kind: 'publisher', label: 'Publishers', items: [] },
  { kind: 'tag', label: 'Tags', items: [] },
]);

const flatResults = computed(() => {
  const out: Array<{ group: GroupedResults; item: GlobalSearchResultItem }> =
    [];
  for (const group of results.value) {
    for (const item of group.items) out.push({ group, item });
  }
  return out;
});

const totalResults = computed(() =>
  results.value.reduce((acc, g) => acc + g.items.length, 0),
);

const highlightedIndex = ref<number>(0);
const rowRefs = ref<HTMLElement[]>([]);

function setRowRef(el: HTMLElement | null, i: number) {
  if (!el) return;
  rowRefs.value[i] = el;
}

function closeModal() {
  uiStore.setGlobalSearchVisible(false);
  query.value = '';
  errorMessage.value = null;
  loading.value = false;
  highlightedIndex.value = 0;
  results.value = [
    { kind: 'book', label: 'Books', items: [] },
    { kind: 'author', label: 'Authors', items: [] },
    { kind: 'series', label: 'Series', items: [] },
    { kind: 'publisher', label: 'Publishers', items: [] },
    { kind: 'tag', label: 'Tags', items: [] },
  ];
}

function scrollToHighlighted() {
  const container = optionsRef.value;
  const el = rowRefs.value[highlightedIndex.value];
  if (!container || !el) return;

  // header = input row (h-12) + padding, mirrors the command palette behavior
  const headerHeight = 84;
  const elTop = el.offsetTop;
  const elBottom = elTop + el.offsetHeight;

  const visibleTop = container.scrollTop + headerHeight;
  const visibleBottom = container.scrollTop + container.clientHeight;

  if (elTop < visibleTop) container.scrollTop = elTop - headerHeight;
  else if (elBottom > visibleBottom)
    container.scrollTop = elBottom - container.clientHeight;
}

function goToResult(item: GlobalSearchResultItem) {
  // NOTE: update these routes if your app uses different paths.
  if (item.kind === 'author') {
    closeModal();
    navigateTo(`/authors/${item.id}`);
    return;
  }

  if (item.kind === 'book') {
    closeModal();
    navigateTo(`/books/${item.id}`);
    return;
  }

  if (item.kind === 'series') {
    closeModal();
    navigateTo(`/series/${item.id}`);
    return;
  }

  if (item.kind === 'publisher') {
    closeModal();
    navigateTo(`/publishers/${item.id}`);
    return;
  }

  if (item.kind === 'tag') {
    closeModal();
    navigateTo(`/tags/${item.id}`);
    return;
  }

  closeModal();
}

function toNameTitle(row: SearchApiBucketRow) {
  return String(row.name ?? row.title ?? '').trim();
}

function coverThumbUrl(coverImagePath: string) {
  // Stored as a relative `library/...` path (typically `.../thumb.webp`)
  // API expects: /api/media/covers/<path under library>
  return `/api/media/covers/${coverImagePath.replace(/^library\//, '')}`;
}

async function runSearch(q: string) {
  const trimmed = q.trim();
  errorMessage.value = null;

  if (!trimmed) {
    results.value = [
      { kind: 'book', label: 'Books', items: [] },
      { kind: 'author', label: 'Authors', items: [] },
      { kind: 'series', label: 'Series', items: [] },
      { kind: 'publisher', label: 'Publishers', items: [] },
      { kind: 'tag', label: 'Tags', items: [] },
    ];
    highlightedIndex.value = 0;
    return;
  }

  loading.value = true;

  try {
    const res = await $fetch<SearchApiResponse>('/api/search', {
      method: 'GET',
      query: { q: trimmed },
    });

    const buckets = res?.data?.buckets;

    const bookItems: GlobalSearchResultItem[] =
      buckets?.books?.map((b) => ({
        kind: 'book',
        id: String(b.id),
        title: String(b.title ?? ''),
        subtitle: b.subtitle ?? null,
        coverImagePath: b.coverImagePath ?? null,
        icon: 'lucide:book',
      })) ?? [];

    const authorItems: GlobalSearchResultItem[] =
      buckets?.authors?.map((r) => ({
        kind: 'author',
        id: String(r.id),
        title: toNameTitle(r),
        subtitle: null,
        icon: 'lucide:user',
      })) ?? [];

    const seriesItems: GlobalSearchResultItem[] =
      buckets?.series?.map((r) => ({
        kind: 'series',
        id: String(r.id),
        title: toNameTitle(r),
        subtitle: null,
        icon: 'lucide:layers',
      })) ?? [];

    const publisherItems: GlobalSearchResultItem[] =
      buckets?.publishers?.map((r) => ({
        kind: 'publisher',
        id: String(r.id),
        title: toNameTitle(r),
        subtitle: null,
        icon: 'lucide:building-2',
      })) ?? [];

    const tagItems: GlobalSearchResultItem[] =
      buckets?.tags?.map((r) => ({
        kind: 'tag',
        id: String(r.id),
        title: toNameTitle(r),
        subtitle: null,
        icon: 'lucide:tag',
      })) ?? [];

    // Keep bucket priority: Books, Authors, Series, then others.
    results.value = [
      { kind: 'book', label: 'Books', items: bookItems },
      { kind: 'author', label: 'Authors', items: authorItems },
      { kind: 'series', label: 'Series', items: seriesItems },
      { kind: 'publisher', label: 'Publishers', items: publisherItems },
      { kind: 'tag', label: 'Tags', items: tagItems },
    ];

    highlightedIndex.value = flatResults.value.length > 0 ? 0 : -1;
    await nextTick();
    scrollToHighlighted();
  } catch {
    errorMessage.value = 'Failed to search. Please try again.';
  } finally {
    loading.value = false;
  }
}

const debouncedSearch = useDebounceFn((q: string) => {
  runSearch(q);
}, 150);

watch(
  () => uiStore.globalSearchVisible,
  (open) => {
    if (open) {
      nextTick(() => inputRef.value?.focus());
    } else {
      query.value = '';
      errorMessage.value = null;
      loading.value = false;
      highlightedIndex.value = 0;
      results.value = [
        { kind: 'book', label: 'Books', items: [] },
        { kind: 'author', label: 'Authors', items: [] },
        { kind: 'series', label: 'Series', items: [] },
        { kind: 'publisher', label: 'Publishers', items: [] },
        { kind: 'tag', label: 'Tags', items: [] },
      ];
    }
  },
);

watch(
  () => query.value,
  (q) => {
    debouncedSearch(q);
  },
);

function handleKeyDown(event: KeyboardEvent) {
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;

  // Cmd/Ctrl+K toggles global search (common convention)
  if (cmdOrCtrl && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    toggleModal();
    return;
  }

  // Only handle the rest if the modal is open
  if (!uiStore.globalSearchVisible) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
    return;
  }

  if (flatResults.value.length === 0) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    const max = flatResults.value.length - 1;
    highlightedIndex.value = Math.min(max, highlightedIndex.value + 1);
    nextTick(scrollToHighlighted);
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    highlightedIndex.value = Math.max(0, highlightedIndex.value - 1);
    nextTick(scrollToHighlighted);
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const picked = flatResults.value[highlightedIndex.value]?.item;
    if (picked) goToResult(picked);
    return;
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <div
    v-if="uiStore.globalSearchVisible"
    class="fixed top-0 left-0 w-full h-full flex items-center justify-center z-50 bg-black/20"
    @click="closeModal"
  >
    <div
      class="flex flex-col backdrop-blur-lg bg-(--bg-color)/80 w-[720px] h-[600px] m-4 rounded-lg shadow-lg font-mono border border-(--sub-color)"
      @click.stop
    >
      <div
        class="h-12 flex items-center px-3 py-2 border-b border-(--sub-color)"
      >
        <Icon name="lucide:search" class="scale-125" />
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          placeholder="search library"
          class="w-full bg-transparent! px-2! rounded-t-lg! rounded-b-none! focus:outline-none"
        />
      </div>

      <div class="h-full overflow-hidden">
        <div ref="optionsRef" class="h-full overflow-y-auto">
          <div
            class="px-3 py-2 text-xs opacity-70 border-b border-(--sub-color)"
          >
            <span v-if="loading">searching…</span>
            <span v-else-if="errorMessage">{{ errorMessage }}</span>
            <span v-else-if="query.trim().length === 0"
              >type to search everything</span
            >
            <span v-else>
              {{ totalResults }} result{{ totalResults === 1 ? '' : 's' }}
            </span>
          </div>

          <div
            v-if="!loading && query.trim().length > 0 && totalResults === 0"
            class="p-3"
          >
            no results
          </div>

          <template v-for="group in results" :key="group.kind">
            <div v-if="group.items.length > 0" class="pb-2">
              <div
                class="px-3 pt-3 pb-1 text-xs uppercase tracking-wide opacity-70"
              >
                {{ group.label }}
              </div>

              <div
                v-for="item in group.items"
                :key="`${item.kind}:${item.id}`"
                :ref="
                  (el) =>
                    setRowRef(
                      el as HTMLElement,
                      flatResults.findIndex(
                        (x) =>
                          x.item.id === item.id && x.item.kind === item.kind,
                      ),
                    )
                "
                class="h-9 cursor-pointer px-3 py-1 hover:bg-(--sub-alt-color) flex items-center gap-2"
                :class="[
                  flatResults[highlightedIndex]?.item?.id === item.id &&
                  flatResults[highlightedIndex]?.item?.kind === item.kind
                    ? 'bg-(--sub-color) text-(--text-color)'
                    : '',
                  item.kind === 'book' ? 'h-12' : 'h-9',
                ]"
                @mouseenter="
                  () => {
                    const idx = flatResults.findIndex(
                      (x) => x.item.id === item.id && x.item.kind === item.kind,
                    );
                    if (idx >= 0) highlightedIndex = idx;
                  }
                "
                @click="goToResult(item)"
              >
                <Icon
                  v-if="item.kind !== 'book' && item.icon"
                  :name="item.icon"
                  class="scale-125 text-(--main-color)"
                />
                <BookCover
                  v-else
                  class="w-auto! aspect-2/3!"
                  :src="coverThumbUrl(item.coverImagePath || '')"
                />
                <div class="flex flex-col min-w-0">
                  <div class="truncate">{{ item.title }}</div>
                  <div v-if="item.subtitle" class="text-xs opacity-70 truncate">
                    {{ item.subtitle }}
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
      <div
        v-if="query.trim().length > 0"
        class="px-3 py-2 text-xs opacity-60 border-t border-(--sub-color) hidden sm:block"
      >
        <span class="opacity-80">enter</span> to open •
        <span class="opacity-80">esc</span> to close •
        <span class="opacity-80">↑/↓</span> to navigate
      </div>
    </div>
  </div>
</template>
