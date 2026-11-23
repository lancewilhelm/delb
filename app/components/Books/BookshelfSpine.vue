<script setup lang="ts">
import { useUserSettingsStore } from '~/stores/userSettings';
import { computed, onMounted, ref, watch } from 'vue';
import type { BookViewBook } from '~/utils/bookFields';
import type { ShelfBook } from '~~/shared/bookshelf';

const loadedSpineSrcs = new Set<string>();
const MAX_LOADED_SPINE_SRCS = 1000;

function rememberLoadedSpine(src: string) {
  if (loadedSpineSrcs.has(src)) return;
  loadedSpineSrcs.add(src);
  if (loadedSpineSrcs.size > MAX_LOADED_SPINE_SRCS) {
    const oldest = loadedSpineSrcs.values().next().value;
    if (oldest !== undefined) loadedSpineSrcs.delete(oldest);
  }
}

const userSettingsStore = useUserSettingsStore();
const props = defineProps<{
  placement: ShelfBook;
  book: BookViewBook;
  horizontal: boolean;
  dimmed?: boolean;
}>();
const colors = [
  '#425d49',
  '#a16855',
  '#a67d45',
  '#657b82',
  '#9b604c',
  '#6c765b',
  '#455d72',
  '#83715f',
];
const color = computed(() => {
  let hash = 0;
  for (const char of props.book.id)
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
});
const spineSrc = computed(() =>
  props.book.spineRevision
    ? `/api/books/${encodeURIComponent(props.book.id)}/spine?v=${encodeURIComponent(props.book.spineRevision)}`
    : null,
);
const imgEl = ref<HTMLImageElement | null>(null);
const failed = ref(false);
const loaded = ref(Boolean(spineSrc.value && loadedSpineSrcs.has(spineSrc.value)));

function onSpineLoad() {
  if (spineSrc.value) rememberLoadedSpine(spineSrc.value);
  loaded.value = true;
}

function onSpineError() {
  if (spineSrc.value) loadedSpineSrcs.delete(spineSrc.value);
  failed.value = true;
}

function syncCompleteState() {
  const el = imgEl.value;
  if (el && el.complete && el.naturalWidth > 0) {
    onSpineLoad();
  }
}

watch(spineSrc, (next) => {
  failed.value = false;
  loaded.value = Boolean(next && loadedSpineSrcs.has(next));
});

onMounted(syncCompleteState);

const author = computed(
  () =>
    props.book.authorNames?.join(', ') ||
    props.book.authors?.map((a) => a.name).join(', ') ||
    props.book.author ||
    '',
);
</script>

<template>
  <span
    class="shelf-spine"
    :class="{
      horizontal,
      dimmed,
      grayscale: userSettingsStore.activeSettings.coverStyle.grayscale,
      'spine-gloss':
        userSettingsStore.activeSettings.coverStyle.detailSpineGloss,
      'spine-gloss-horizontal': horizontal,
    }"
    :style="{ background: color }"
  >
    <img
      v-if="spineSrc && !failed"
      ref="imgEl"
      class="spine-art"
      :class="{ sideways: horizontal, pending: !loaded }"
      decoding="async"
      :style="
        horizontal
          ? { width: `${placement.width}px`, height: `${placement.height}px` }
          : undefined
      "
      :src="spineSrc"
      :alt="`Spine for ${book.title}`"
      @load="onSpineLoad"
      @error="onSpineError"
    />
    <template v-if="!spineSrc || failed || !loaded"
      ><span class="spine-title">{{ book.title }}</span
      ><span class="spine-author">{{ author }}</span></template
    >
  </span>
</template>

<style scoped>
.shelf-spine {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 3px 3px 1px 1px;
  box-shadow: 1px 2px 3px #0003;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  padding: 8px 3px;
  color: white;
  overflow: hidden;
  writing-mode: vertical-rl;
  text-align: center;
}
.shelf-spine.horizontal {
  writing-mode: horizontal-tb;
  padding: 2px 7px;
  white-space: nowrap;
}
.spine-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
}
.spine-art.pending {
  visibility: hidden;
}
.spine-art.sideways {
  inset: auto;
  left: 0;
  top: 100%;
  transform-origin: top left;
  transform: rotate(-90deg);
}
.spine-title {
  font:
    bold 12px Georgia,
    serif;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spine-author {
  font-size: 8px;
  letter-spacing: 0.05em;
  overflow: hidden;
}
.dimmed {
  filter: grayscale(1);
  opacity: 0.24;
}
</style>
