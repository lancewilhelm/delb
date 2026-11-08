<script setup lang="ts">
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { v4 as uuidv4 } from 'uuid';
import { pdfLocation, pdfPage } from '~/utils/readerFile';

const props = defineProps<{
  bookId: string;
  fileId: string;
  title: string;
  progressSyncEnabled: boolean;
}>();
const emit = defineEmits<{ back: [] }>();
const viewport = ref<HTMLElement | null>(null);
const pdf = shallowRef<PDFDocumentProxy | null>(null);
const viewportWidth = ref(0);
const viewportHeight = ref(0);
const defaultRatio = ref(1.4);
const pageNumber = ref(1);
const pageCount = ref(0);
const zoom = ref(1);
const loading = ref(true);
const rendering = ref(false);
const error = ref('');
const saveError = ref('');
const downloadUrl = computed(
  () =>
    `/api/books/${encodeURIComponent(props.bookId)}/download?format=pdf&fileId=${encodeURIComponent(props.fileId)}`,
);
const positionUrl = `/api/books/${encodeURIComponent(props.bookId)}/reading-position`;
const clientSessionId = uuidv4();
let clientSequence = 0;
let loadingTask: PDFDocumentLoadingTask | null = null;
let disposed = false;
let initialReady = false;
let scrollFrame = 0;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame = 0;
let saveTimeout: ReturnType<typeof setTimeout> | undefined;
type Position = {
  location: string;
  progress: number;
  clientSessionId: string;
  clientSequence: number;
};
let latestPosition: Position | null = null;
let pendingPosition: Position | null = null;
let saveQueue: Promise<void> = Promise.resolve();

function scheduleSave(page: number) {
  latestPosition = {
    location: pdfLocation(props.fileId, page),
    progress: (page / pageCount.value) * 100,
    clientSessionId,
    clientSequence: ++clientSequence,
  };
  pendingPosition = latestPosition;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => void flushPosition(), 500);
}

async function flushPosition() {
  clearTimeout(saveTimeout);
  const position = pendingPosition;
  pendingPosition = null;
  if (position) {
    saveQueue = saveQueue.then(async () => {
      try {
        await $fetch(positionUrl, { method: 'PUT', body: position });
        saveError.value = '';
      } catch {
        saveError.value = 'Could not save your position.';
        if (!pendingPosition && latestPosition === position)
          pendingPosition = position;
      }
    });
  }
  await saveQueue;
}

function onPageHide() {
  if (!latestPosition) return;
  void fetch(positionUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(latestPosition),
    keepalive: true,
  }).catch(() => {});
}

function updateViewport() {
  if (!viewport.value) return;
  viewportWidth.value = Math.max(1, viewport.value.clientWidth - 32);
  viewportHeight.value = Math.max(1, viewport.value.clientHeight - 32);
}

function scrollToPage(page: number) {
  const container = viewport.value;
  const target = container?.querySelector<HTMLElement>(
    `[data-pdf-page="${page}"]`,
  );
  if (!container || !target) return;
  container.scrollTop = target.offsetTop - 16;
}

function onScroll() {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    const container = viewport.value;
    if (!container || !initialReady) return;
    const marker =
      container.getBoundingClientRect().top + container.clientHeight / 3;
    let current = 1;
    for (const page of container.querySelectorAll<HTMLElement>(
      '[data-pdf-page]',
    )) {
      if (page.getBoundingClientRect().top > marker) break;
      current = Number(page.dataset.pdfPage);
    }
    if (current !== pageNumber.value) {
      pageNumber.value = current;
      scheduleSave(current);
    }
  });
}

function pageRendered(page: number) {
  if (initialReady && page === pageNumber.value && rendering.value) {
    rendering.value = false;
    scheduleSave(page);
  }
}

function changeZoom(delta: number) {
  const container = viewport.value;
  const page = container?.querySelector<HTMLElement>(
    `[data-pdf-page="${pageNumber.value}"]`,
  );
  const offset =
    container && page
      ? (container.scrollTop - page.offsetTop) / page.offsetHeight
      : 0;
  zoom.value = Math.max(
    0.5,
    Math.min(3, Math.round((zoom.value + delta) * 4) / 4),
  );
  void nextTick(() => {
    if (container && page) {
      container.scrollTop = page.offsetTop + page.offsetHeight * offset;
    }
  });
}

async function openPdf() {
  loading.value = true;
  error.value = '';
  initialReady = false;
  pdf.value = null;
  await nextTick();
  await loadingTask?.destroy();
  loadingTask = null;
  try {
    const pdfjs = await import('pdfjs-dist');
    const { default: workerUrl } =
      await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    if (disposed) return;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    loadingTask = pdfjs.getDocument({
      url: downloadUrl.value,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      disableRange: true,
      enableXfa: false,
      canvasMaxAreaInBytes: 64_000_000,
    });
    const [loadedPdf, saved] = await Promise.all([
      loadingTask.promise,
      $fetch<{ data: { location: string | null } }>(positionUrl),
    ]);
    if (disposed) return;
    pageCount.value = loadedPdf.numPages;
    const firstPage = await loadedPdf.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    defaultRatio.value = firstViewport.height / firstViewport.width;
    firstPage.cleanup();
    let initialPage = pdfPage(
      saved.data.location,
      props.fileId,
      loadedPdf.numPages,
    );
    if (props.progressSyncEnabled) {
      const history = await $fetch<{
        data: { logs: Array<{ progressPercent: number }> };
      }>(
        `/api/books/${encodeURIComponent(props.bookId)}/progress-logs?limit=1`,
      );
      const percent = history.data.logs[0]?.progressPercent;
      if (percent != null && Number.isFinite(percent)) {
        initialPage = Math.max(
          1,
          Math.min(
            loadedPdf.numPages,
            Math.ceil((percent / 100) * loadedPdf.numPages),
          ),
        );
      }
    }
    if (disposed) return;
    pageNumber.value = initialPage;
    updateViewport();
    rendering.value = true;
    pdf.value = loadedPdf;
    await nextTick();
    scrollToPage(initialPage);
    initialReady = true;
  } catch (cause) {
    if (disposed) return;
    const name = cause instanceof Error ? cause.name : '';
    error.value =
      name === 'PasswordException'
        ? 'Password-protected PDFs are not supported. Download the file to open it in another reader.'
        : 'Could not open this PDF or load your saved position. Try again or download the file.';
    await loadingTask?.destroy();
    loadingTask = null;
    pdf.value = null;
    rendering.value = false;
  } finally {
    if (!disposed) loading.value = false;
  }
}

function goToPage(value: number) {
  if (!Number.isInteger(value)) return;
  const page = Math.max(1, Math.min(pageCount.value, value));
  pageNumber.value = page;
  scrollToPage(page);
  scheduleSave(page);
}

function commitPage(event: Event) {
  const input = event.target as HTMLInputElement;
  goToPage(Number(input.value));
  input.value = String(pageNumber.value);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    emit('back');
    return;
  }
  if ((event.target as HTMLElement)?.closest('input, select, textarea, button'))
    return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    goToPage(pageNumber.value + (event.key === 'ArrowRight' ? 1 : -1));
  }
}

onBeforeRouteLeave(flushPosition);
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('pagehide', onPageHide);
  resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      updateViewport();
    });
  });
  if (viewport.value) resizeObserver.observe(viewport.value);
  void openPdf();
});
onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(scrollFrame);
  clearTimeout(saveTimeout);
  void flushPosition();
  resizeObserver?.disconnect();
  cancelAnimationFrame(resizeFrame);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('pagehide', onPageHide);
  void loadingTask?.destroy();
});
</script>

<template>
  <section
    class="flex h-full w-full flex-col overflow-hidden"
    aria-label="PDF reader"
  >
    <header
      class="flex flex-wrap items-center gap-3 border-b border-(--contrast-border-color) bg-(--sub-alt-color) p-2"
    >
      <button
        type="button"
        aria-label="Back to book"
        class="cursor-pointer p-1"
        @click="emit('back')"
      >
        <Icon name="lucide:arrow-left" class="text-2xl" />
      </button>
      <h1 class="min-w-0 flex-1 truncate text-lg! font-semibold">
        {{ title }}
      </h1>
      <a
        :href="downloadUrl"
        class="rounded border border-(--contrast-border-color) px-2 py-1 text-sm"
        >Download PDF</a
      >
    </header>
    <nav
      class="flex flex-wrap items-center justify-center gap-2 border-b border-(--contrast-border-color) bg-(--sub-alt-color) px-3 py-2 text-sm"
      aria-label="PDF controls"
    >
      <div
        class="flex items-center gap-1 rounded-xl border border-(--contrast-border-color) bg-(--bg-color) p-1"
      >
        <button
          type="button"
          aria-label="Previous page"
          class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-(--sub-color)/10 disabled:cursor-default disabled:opacity-40"
          :disabled="loading || pageNumber <= 1"
          @click="goToPage(pageNumber - 1)"
        >
          <Icon name="lucide:chevron-left" class="text-lg" />
        </button>
        <label class="flex items-center gap-1.5 px-1">
          <span class="sr-only">Page</span>
          <input
            :value="pageNumber"
            aria-label="Page number"
            type="number"
            min="1"
            :max="pageCount || 1"
            :disabled="loading || !pageCount"
            class="w-12 rounded-md bg-(--sub-alt-color) px-1 py-1 text-center tabular-nums"
            @change="commitPage"
          />
          <span class="whitespace-nowrap text-(--sub-color)"
            >/ {{ pageCount || '—' }}</span
          >
        </label>
        <button
          type="button"
          aria-label="Next page"
          class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-(--sub-color)/10 disabled:cursor-default disabled:opacity-40"
          :disabled="loading || pageNumber >= pageCount"
          @click="goToPage(pageNumber + 1)"
        >
          <Icon name="lucide:chevron-right" class="text-lg" />
        </button>
      </div>
      <div
        class="flex items-center gap-1 rounded-xl border border-(--contrast-border-color) bg-(--bg-color) p-1"
      >
        <button
          type="button"
          aria-label="Zoom out"
          class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-(--sub-color)/10 disabled:cursor-default disabled:opacity-40"
          :disabled="loading || zoom <= 0.5"
          @click="changeZoom(-0.25)"
        >
          <Icon name="lucide:minus" class="text-lg" />
        </button>
        <button
          type="button"
          aria-label="Reset zoom"
          title="Reset to fit page"
          class="min-w-14 cursor-pointer rounded-lg px-1 py-1.5 text-center tabular-nums hover:bg-(--sub-color)/10"
          :disabled="loading"
          @click="changeZoom(1 - zoom)"
        >
          {{ Math.round(zoom * 100) }}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-(--sub-color)/10 disabled:cursor-default disabled:opacity-40"
          :disabled="loading || zoom >= 3"
          @click="changeZoom(0.25)"
        >
          <Icon name="lucide:plus" class="text-lg" />
        </button>
      </div>
    </nav>
    <div v-if="saveError" role="alert" class="p-2 text-center text-sm">
      {{ saveError }}
      <button type="button" class="underline" @click="flushPosition">
        Retry save
      </button>
    </div>
    <div
      ref="viewport"
      class="relative min-h-0 flex-1 overflow-auto bg-neutral-700"
      :aria-busy="loading || rendering"
      @scroll.passive="onScroll"
    >
      <div
        v-if="loading || rendering"
        role="status"
        class="absolute inset-x-0 top-0 bg-(--bg-color) p-2 text-center text-sm"
      >
        Loading PDF…
      </div>
      <div
        v-if="error"
        role="alert"
        class="absolute inset-x-0 top-0 bg-(--bg-color) p-3 text-center text-sm"
      >
        {{ error }}
        <button
          type="button"
          class="ml-2 underline"
          :disabled="loading"
          @click="openPdf()"
        >
          Try again
        </button>
      </div>
      <div
        v-if="pdf && viewport"
        class="relative flex w-max min-w-full flex-col items-center gap-4 p-4"
      >
        <ReadersPdfPage
          v-for="page in pageCount"
          :key="page"
          :pdf="pdf"
          :page="page"
          :viewport="viewport"
          :width="viewportWidth"
          :height="viewportHeight"
          :zoom="zoom"
          :default-ratio="defaultRatio"
          @rendered="pageRendered"
          @failed="
            error =
              'Could not display this PDF page. Try again or download the file.';
            rendering = false;
          "
        />
      </div>
    </div>
  </section>
</template>
