<script setup lang="ts">
import { $fetch } from '~/utils/apiFetch';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

type Progress = {
  progressPercent: number;
  pageNumber: number | null;
  source: string;
  occurredDate: string;
};
type ProgressView = {
  latest: Progress | null;
  history: (Progress & { id: string })[];
  hasMore: boolean;
};
const props = defineProps<{ bookId: string; refreshKey: number }>();
const progress = ref<ProgressView | null>(null);
const loading = ref(true);
const error = ref(false);
let sequence = 0;
let controller: AbortController | undefined;

async function refresh() {
  const request = ++sequence;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = false;
  try {
    const result = await $fetch<{ data: ProgressView }>(
      `/api/books/${encodeURIComponent(props.bookId)}/progress`,
      { signal: controller.signal },
    );
    if (request === sequence) progress.value = result.data;
  } catch {
    if (request === sequence) error.value = true;
  } finally {
    if (request === sequence) loading.value = false;
  }
}
function description(entry: Progress) {
  const source =
    entry.source === 'reader'
      ? 'Reader'
      : entry.source === 'manual'
        ? 'Manually logged'
        : entry.source === 'status-finished'
          ? 'Marked finished'
          : 'Progress';
  return `${entry.progressPercent.toFixed(1)}%${entry.pageNumber !== null ? ` · Page ${entry.pageNumber}` : ''} · ${entry.occurredDate} · ${source}`;
}
onMounted(() => {
  void refresh();
  window.addEventListener('focus', refresh);
});
watch(
  () => [props.bookId, props.refreshKey],
  () => {
    progress.value = null;
    void refresh();
  },
);
onBeforeUnmount(() => {
  sequence++;
  controller?.abort();
  window.removeEventListener('focus', refresh);
});
</script>

<template>
  <div class="w-full text-right text-sm">
    <div v-if="loading && !progress" role="status" class="opacity-70">
      Loading progress…
    </div>
    <div v-else-if="error" role="alert" class="text-(--contrast-error-color)">
      Could not load progress.
      <button type="button" class="underline" @click="refresh">Retry</button>
    </div>
    <template v-else-if="progress">
      <div v-if="progress.latest">
        <span class="font-semibold">Latest progress:</span>
        {{ description(progress.latest) }}
      </div>
      <div v-else class="opacity-70">No progress recorded yet.</div>
      <details v-if="progress.history.length" class="mt-2">
        <summary class="cursor-pointer underline">
          Progress history{{
            progress.hasMore
              ? ' (most recent 50)'
              : ` (${progress.history.length})`
          }}
        </summary>
        <ul class="mt-2 space-y-1 opacity-80">
          <li v-for="entry in progress.history" :key="entry.id">
            {{ description(entry) }}
          </li>
        </ul>
      </details>
      <button
        type="button"
        class="mt-2 underline opacity-70 hover:opacity-100"
        :disabled="loading"
        @click="refresh"
      >
        Refresh progress
      </button>
    </template>
  </div>
</template>
