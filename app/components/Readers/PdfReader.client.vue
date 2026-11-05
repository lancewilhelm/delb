<script setup lang="ts">
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist';
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
const pageHost = ref<HTMLElement | null>(null);
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
let document: PDFDocumentProxy | null = null;
let loadingTask: PDFDocumentLoadingTask | null = null;
let renderTask: RenderTask | null = null;
let renderVersion = 0;
let disposed = false;
let displayedPage = 0;
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

async function renderPage() {
  if (!document || !viewport.value || !pageHost.value || disposed) return;
  const version = ++renderVersion;
  renderTask?.cancel();
  rendering.value = true;
  error.value = '';
  const pageToRender = pageNumber.value;
  try {
    const page = await document.getPage(pageToRender);
    if (disposed || version !== renderVersion) return;
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(
      Math.max(1, viewport.value.clientWidth - 32) / base.width,
      Math.max(1, viewport.value.clientHeight - 32) / base.height,
    );
    const view = page.getViewport({ scale: fit * zoom.value });
    // Keep large pages and high-DPI screens within a single 16-megapixel canvas.
    const outputScale = Math.min(
      window.devicePixelRatio || 1,
      2,
      Math.sqrt(16_000_000 / (view.width * view.height)),
    );
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(view.width * outputScale));
    canvas.height = Math.max(1, Math.floor(view.height * outputScale));
    canvas.style.width = `${view.width}px`;
    canvas.style.height = `${view.height}px`;
    canvas.style.display = 'block';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      `Page ${pageToRender} of ${pageCount.value}`,
    );
    const task = page.render({
      canvas,
      viewport: view,
      transform: [outputScale, 0, 0, outputScale, 0, 0],
    });
    renderTask = task;
    await task.promise;
    if (disposed || version !== renderVersion) return;
    pageHost.value.replaceChildren(canvas);
    viewport.value.scrollTo(0, 0);
    if (displayedPage !== pageToRender) {
      displayedPage = pageToRender;
      scheduleSave(pageToRender);
    }
    page.cleanup();
  } catch (cause) {
    if (!disposed && version === renderVersion) {
      error.value =
        'Could not display this PDF page. Try again or download the file.';
      console.error('PDF page rendering failed', cause);
    }
  } finally {
    if (!disposed && version === renderVersion) rendering.value = false;
  }
}

async function openPdf() {
  loading.value = true;
  error.value = '';
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
    const [pdf, saved] = await Promise.all([
      loadingTask.promise,
      $fetch<{ data: { location: string | null } }>(positionUrl),
    ]);
    if (disposed) return;
    document = pdf;
    pageCount.value = document.numPages;
    let initialPage = pdfPage(
      saved.data.location,
      props.fileId,
      document.numPages,
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
            document.numPages,
            Math.ceil((percent / 100) * document.numPages),
          ),
        );
      }
    }
    if (disposed) return;
    pageNumber.value = initialPage;
    await renderPage();
  } catch (cause) {
    if (disposed) return;
    const name = cause instanceof Error ? cause.name : '';
    error.value =
      name === 'PasswordException'
        ? 'Password-protected PDFs are not supported. Download the file to open it in another reader.'
        : 'Could not open this PDF or load your saved position. Try again or download the file.';
    await loadingTask?.destroy();
    loadingTask = null;
    document = null;
  } finally {
    if (!disposed) loading.value = false;
  }
}

function goToPage(value: number) {
  if (!Number.isInteger(value)) return;
  pageNumber.value = Math.max(1, Math.min(pageCount.value, value));
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

watch([pageNumber, zoom], () => {
  if (!loading.value) void renderPage();
});
onBeforeRouteLeave(flushPosition);
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('pagehide', onPageHide);
  resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!loading.value) void renderPage();
    });
  });
  if (viewport.value) resizeObserver.observe(viewport.value);
  void openPdf();
});
onBeforeUnmount(() => {
  disposed = true;
  renderVersion += 1;
  clearTimeout(saveTimeout);
  void flushPosition();
  resizeObserver?.disconnect();
  cancelAnimationFrame(resizeFrame);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('pagehide', onPageHide);
  renderTask?.cancel();
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
      class="flex flex-wrap items-center justify-center gap-3 border-b border-(--contrast-border-color) p-2 text-sm"
      aria-label="PDF controls"
    >
      <button
        type="button"
        aria-label="Previous page"
        class="cursor-pointer p-1 disabled:opacity-40"
        :disabled="loading || pageNumber <= 1"
        @click="goToPage(pageNumber - 1)"
      >
        <Icon name="lucide:chevron-left" class="text-xl" />
      </button>
      <label class="flex items-center gap-2">
        Page
        <input
          :value="pageNumber"
          aria-label="Page number"
          type="number"
          min="1"
          :max="pageCount || 1"
          :disabled="loading || !pageCount"
          class="w-16 rounded border border-(--contrast-border-color) p-1 text-center"
          @change="commitPage"
        />
        <span>of {{ pageCount || '—' }}</span>
      </label>
      <button
        type="button"
        aria-label="Next page"
        class="cursor-pointer p-1 disabled:opacity-40"
        :disabled="loading || pageNumber >= pageCount"
        @click="goToPage(pageNumber + 1)"
      >
        <Icon name="lucide:chevron-right" class="text-xl" />
      </button>
      <label class="flex items-center gap-2">
        Zoom
        <select
          v-model.number="zoom"
          aria-label="PDF zoom"
          class="rounded border border-(--contrast-border-color) bg-(--bg-color) p-1"
        >
          <option :value="1">Fit page</option>
          <option :value="1.5">150%</option>
          <option :value="2">200%</option>
          <option :value="3">300%</option>
        </select>
      </label>
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
          @click="document ? renderPage() : openPdf()"
        >
          Try again
        </button>
      </div>
      <div ref="pageHost" class="mx-auto my-4 w-fit bg-white shadow" />
    </div>
  </section>
</template>
