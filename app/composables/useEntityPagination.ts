import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

export function useEntityPagination<T>(options: {
  inputs: () => { search: string; previewLimit: number; collectionId?: string };
  initialize: () => Promise<void>;
  fetchPage: (
    query: Record<string, string>,
  ) => Promise<{ rows: T[]; hasMore: boolean }>;
  failureMessage: string;
}) {
  const rows = shallowRef<T[]>([]);
  const hasMore = ref(false);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const scrollRoot = shallowRef<HTMLElement | null>(null);
  let generation = 0;
  let ready = false;
  let disposed = false;
  let snapshot = options.inputs();

  async function load(append: boolean) {
    if (append && (loading.value || !hasMore.value)) return;
    const request = append ? generation : ++generation;
    if (!append) {
      snapshot = options.inputs();
      rows.value = [];
      hasMore.value = false;
    }
    loading.value = true;
    error.value = null;
    const query: Record<string, string> = {
      offset: String(append ? rows.value.length : 0),
      search: snapshot.search.trim(),
      previewLimit: String(snapshot.previewLimit),
    };
    if (snapshot.collectionId) query.collectionId = snapshot.collectionId;
    try {
      const result = await options.fetchPage(query);
      if (disposed || request !== generation) return;
      rows.value = append ? [...rows.value, ...result.rows] : result.rows;
      hasMore.value = result.hasMore;
      if (result.hasMore && result.rows.length === 0) {
        error.value = 'No more results were returned. Try again.';
      }
    } catch (err) {
      if (disposed || request !== generation) return;
      const e = err as {
        data?: { message?: string };
        statusMessage?: string;
        message?: string;
      };
      error.value =
        e?.data?.message ||
        e?.statusMessage ||
        e?.message ||
        options.failureMessage;
    } finally {
      if (!disposed && request === generation) loading.value = false;
    }
  }

  function reset() {
    return load(false);
  }
  function loadMore() {
    return load(true);
  }
  function retry() {
    return rows.value.length ? loadMore() : reset();
  }

  watch(
    options.inputs,
    () => {
      if (ready) void reset();
    },
    { deep: true, flush: 'sync' },
  );
  onMounted(async () => {
    try {
      await options.initialize();
    } finally {
      if (!disposed) {
        ready = true;
        void reset();
      }
    }
  });
  onBeforeUnmount(() => {
    disposed = true;
    generation++;
  });
  return { rows, hasMore, loading, error, scrollRoot, reset, loadMore, retry };
}
