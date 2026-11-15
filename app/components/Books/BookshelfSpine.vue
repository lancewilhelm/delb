<script setup lang="ts">
import type { BookViewBook } from '~/utils/bookFields';
import type { ShelfBook } from '~~/shared/bookshelf';

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
const failed = ref(false);
const loaded = ref(false);
watch(
  () => [props.book.id, props.book.spineRevision],
  () => {
    failed.value = false;
    loaded.value = false;
  },
);
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
    :class="{ horizontal, dimmed }"
    :style="{ background: color }"
  >
    <img
      v-if="book.spineRevision && !failed"
      class="spine-art"
      :class="{ sideways: horizontal, pending: !loaded }"
      loading="lazy"
      decoding="async"
      :style="
        horizontal
          ? { width: `${placement.width}px`, height: `${placement.height}px` }
          : undefined
      "
      :src="`/api/books/${encodeURIComponent(book.id)}/spine?v=${encodeURIComponent(book.spineRevision)}`"
      :alt="`Spine for ${book.title}`"
      @load="loaded = true"
      @error="failed = true"
    />
    <template v-if="!book.spineRevision || failed || !loaded"
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
.shelf-spine::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow:
    inset 2px 0 3px #ffffff38,
    inset -3px 0 4px #0003;
  pointer-events: none;
}
.shelf-spine.horizontal {
  writing-mode: horizontal-tb;
  padding: 2px 7px;
  white-space: nowrap;
}
.shelf-spine.horizontal::after {
  box-shadow:
    inset 0 2px 3px #ffffff38,
    inset 0 -3px 4px #0003;
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
