<script setup lang="ts">
import { useElementSize } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import BookshelfSpine from '~/components/Books/BookshelfSpine.vue';
import {
  DASHBOARD_SPINE_MAX_HEIGHT,
  fillShelf,
  type SpineBook,
} from '~/utils/dashboardShelf';

/**
 * One row of spines standing on a plain ground in the theme's colors. The
 * spines are the bookshelf's own, scaled to fit the box.
 */
const props = withDefaults(
  defineProps<{
    books: SpineBook[];
    /** Where the row starts, as a fraction of the box width; the ground spans it all. */
    start?: number;
  }>(),
  { start: 0 },
);

const emit = defineEmits<{
  /** Every book fits and there is room for more. */
  (e: 'room'): void;
}>();

/** Ground thickness: a share of the box height, up to a fixed size. */
const GROUND_SHARE = 0.11;
const MAX_GROUND_PX = 24;
/** Space kept above the tallest spine, as a share of the box height. */
const HEADROOM_SHARE = 0.1;

const box = ref<HTMLElement | null>(null);
const { width, height } = useElementSize(box);

const ground = computed(() =>
  Math.min(MAX_GROUND_PX, Math.round(height.value * GROUND_SHARE)),
);
// Spines never draw bigger than they do on the bookshelf.
const scale = computed(() =>
  height.value > 0
    ? Math.min(
        1,
        (height.value * (1 - HEADROOM_SHARE) - ground.value) /
          DASHBOARD_SPINE_MAX_HEIGHT,
      )
    : 0,
);
const left = computed(() => Math.round(width.value * props.start));
const rowWidth = computed(() =>
  scale.value > 0 ? Math.floor((width.value - left.value) / scale.value) : 0,
);
const spines = computed(() =>
  rowWidth.value > 0 ? fillShelf(props.books, rowWidth.value) : [],
);

watch(
  spines,
  (row) => {
    if (rowWidth.value > 0 && row.length >= props.books.length) emit('room');
  },
  { immediate: true },
);
</script>

<template>
  <div ref="box" class="dash-shelf" :style="{ '--ground': `${ground}px` }">
    <div class="dash-shelf-ground"></div>
    <div
      v-if="scale > 0"
      class="dash-shelf-row"
      :style="{
        left: `${left}px`,
        width: `${rowWidth}px`,
        height: `${DASHBOARD_SPINE_MAX_HEIGHT}px`,
        transform: `scale(${scale})`,
      }"
    >
      <div
        v-for="spine in spines"
        :key="spine.book.id"
        class="dash-shelf-item"
        :style="{
          left: `${spine.x}px`,
          width: `${spine.width}px`,
          height: `${spine.height}px`,
        }"
      >
        <BookshelfSpine
          :placement="{
            id: spine.book.id,
            width: spine.width,
            height: spine.height,
            manualWidth: false,
            manualHeight: false,
            sourcePages: spine.book.pages ?? null,
          }"
          :book="spine.book"
          :horizontal="false"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.dash-shelf {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
/* The same ledge the dashboard has always used, from the theme's colors. */
.dash-shelf-ground {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--ground);
  background: color-mix(in srgb, var(--sub-color) 40%, var(--sub-alt-color));
  box-shadow: 0 -1px 0 color-mix(in srgb, var(--sub-color) 60%, transparent);
}
.dash-shelf-row {
  position: absolute;
  bottom: var(--ground);
  transform-origin: bottom left;
}
.dash-shelf-item {
  position: absolute;
  bottom: 0;
}
</style>
