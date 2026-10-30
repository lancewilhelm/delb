<script setup lang="ts">
const props = defineProps<{
  root: HTMLElement | null;
  rowCount: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}>();
const emit = defineEmits<{ load: []; retry: [] }>();
const sentinel = ref<HTMLElement | null>(null);
const focused = ref(false);
let observer: IntersectionObserver | undefined;

watch(
  () =>
    [
      props.root,
      props.rowCount,
      sentinel.value,
      props.hasMore,
      props.loading,
      props.error,
    ] as const,
  () => {
    observer?.disconnect();
    observer = undefined;
    if (
      !props.root ||
      !sentinel.value ||
      !props.hasMore ||
      props.loading ||
      props.error ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    const currentObserver = new IntersectionObserver(
      (entries) => {
        if (
          observer === currentObserver &&
          !props.loading &&
          !props.error &&
          props.hasMore &&
          entries.some((entry) => entry.isIntersecting)
        )
          emit('load');
      },
      { root: props.root },
    );
    observer = currentObserver;
    currentObserver.observe(sentinel.value);
  },
  { immediate: true, flush: 'post' },
);
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div v-if="hasMore || error || focused" ref="sentinel" class="space-y-2">
    <p v-if="error" class="text-sm text-(--error-color)" role="alert">
      {{ error }}
    </p>
    <button
      type="button"
      class="px-3 py-2 rounded-md border border-(--sub-color) text-sm"
      :aria-disabled="loading || (!hasMore && !error)"
      @focus="focused = true"
      @blur="focused = false"
      @click="!loading && (error ? emit('retry') : hasMore && emit('load'))"
    >
      {{
        loading
          ? 'Loading...'
          : error
            ? 'Retry'
            : hasMore
              ? 'Load more'
              : 'All loaded'
      }}
    </button>
  </div>
</template>
