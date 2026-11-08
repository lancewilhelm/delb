<script setup lang="ts">
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

const props = defineProps<{
  pdf: PDFDocumentProxy;
  page: number;
  viewport: HTMLElement;
  width: number;
  height: number;
  zoom: number;
  defaultRatio: number;
}>();
const emit = defineEmits<{ rendered: [page: number]; failed: [] }>();
const host = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const ratio = ref(props.defaultRatio);
const naturalWidth = ref(0);
const naturalHeight = ref(0);
const visible = ref(false);
let observer: IntersectionObserver | null = null;
let task: RenderTask | null = null;
let version = 0;

const pageWidth = computed(() => {
  if (!naturalWidth.value || !naturalHeight.value) {
    return Math.min(props.width, props.height / ratio.value) * props.zoom;
  }
  return (
    Math.min(
      props.width,
      (props.height * naturalWidth.value) / naturalHeight.value,
    ) * props.zoom
  );
});

async function render() {
  const current = ++version;
  const previous = task;
  previous?.cancel();
  if (previous) await previous.promise.catch(() => {});
  if (current !== version || !visible.value || !canvas.value) return;
  try {
    const page = await props.pdf.getPage(props.page);
    if (current !== version || !canvas.value) return;
    const base = page.getViewport({ scale: 1 });
    naturalWidth.value = base.width;
    naturalHeight.value = base.height;
    ratio.value = base.height / base.width;
    const view = page.getViewport({ scale: pageWidth.value / base.width });
    const outputScale = Math.min(
      window.devicePixelRatio || 1,
      2,
      Math.sqrt(16_000_000 / (view.width * view.height)),
    );
    const target = window.document.createElement('canvas');
    target.width = Math.max(1, Math.floor(view.width * outputScale));
    target.height = Math.max(1, Math.floor(view.height * outputScale));
    const rendering = page.render({
      canvas: target,
      viewport: view,
      transform: [outputScale, 0, 0, outputScale, 0, 0],
    });
    task = rendering;
    await rendering.promise;
    if (current !== version || !canvas.value) return;
    canvas.value.width = target.width;
    canvas.value.height = target.height;
    canvas.value.getContext('2d')?.drawImage(target, 0, 0);
    emit('rendered', props.page);
    page.cleanup();
  } catch (error) {
    if (current === version) {
      console.error('PDF page rendering failed', error);
      emit('failed');
    }
  }
}

watch(
  [visible, () => props.width, () => props.height, () => props.zoom],
  render,
);
onMounted(() => {
  observer = new IntersectionObserver(
    ([entry]) => {
      visible.value = entry!.isIntersecting;
      if (!visible.value && canvas.value) {
        canvas.value.width = 0;
        canvas.value.height = 0;
      }
    },
    { root: props.viewport, rootMargin: '100% 0px' },
  );
  if (host.value) observer.observe(host.value);
});
onBeforeUnmount(() => {
  version++;
  task?.cancel();
  observer?.disconnect();
});
</script>

<template>
  <div
    ref="host"
    :data-pdf-page="page"
    class="relative mx-auto bg-white shadow-lg"
    :style="{ width: `${pageWidth}px`, aspectRatio: `1 / ${ratio}` }"
  >
    <canvas
      ref="canvas"
      role="img"
      :aria-label="`Page ${page}`"
      class="block h-full w-full"
    />
  </div>
</template>
