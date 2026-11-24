<script setup lang="ts">
import { usePreferredReducedMotion } from '@vueuse/core';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import DashboardCover from '~/components/Dashboard/DashboardCover.vue';
import { pileLayout, type PileRegion } from '~/utils/dashboardArt';
import { attachPilePhysics } from '~/utils/pilePhysics';

/**
 * A draggable pile of covers: a fresh random scatter on every page load
 * drops in, then the reader can pick books up, toss them, and watch them settle.
 */
const props = withDefaults(
  defineProps<{
    books: {
      id: string;
      title: string;
      coverImagePath?: string | null;
      updatedAt?: string;
    }[];
    /** Distinguishes piles that show the same books on one page. */
    seed: string;
    /** Cover height as a fraction of the pile's height. */
    coverHeight?: number;
    /** Where books may rest, as fractions of the pile's box. */
    region?: PileRegion;
  }>(),
  { coverHeight: 0.5, region: undefined },
);

const reducedMotion = usePreferredReducedMotion();
// New each time the pile mounts (every page load), so the books land somewhere
// new; kept across re-renders so a data refresh doesn't re-throw the pile.
const throwId = Math.random().toString(36).slice(2);
const box = ref<HTMLElement | null>(null);
let physics: ReturnType<typeof attachPilePhysics> | null = null;

async function setup() {
  physics?.dispose();
  physics = null;
  await nextTick();
  const el = box.value;
  if (!el || !el.clientWidth || !el.clientHeight) return;
  const placements = pileLayout(
    props.books.map((book) => book.id),
    `${props.seed}:${throwId}`,
    {
      aspect: el.clientWidth / el.clientHeight,
      coverHeight: props.coverHeight,
      region: props.region,
    },
  );
  physics = attachPilePhysics(
    el,
    Array.from(el.querySelectorAll<HTMLElement>(':scope > .pile-item')),
    placements,
    { reducedMotion: reducedMotion.value === 'reduce', region: props.region },
  );
}

/** A drag inside a linked card must not also open it. */
function onClickCapture(event: MouseEvent) {
  if (physics?.consumeDrag()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

onMounted(setup);
watch(
  () => [
    props.seed,
    props.coverHeight,
    JSON.stringify(props.region ?? null),
    props.books.map((book) => book.id).join(),
  ],
  setup,
);
onBeforeUnmount(() => physics?.dispose());
</script>

<template>
  <div
    ref="box"
    class="pile"
    :style="{ '--pile-cover-h': `${coverHeight * 100}cqh` }"
    @click.capture="onClickCapture"
  >
    <DashboardCover
      v-for="book in books"
      :key="book.id"
      :book="book"
      class="pile-item"
    />
  </div>
</template>

<style scoped>
.pile {
  position: absolute;
  inset: 0;
  container-type: size;
  perspective: 700px;
}
.pile-item {
  position: absolute;
  left: 0;
  top: 0;
  height: var(--pile-cover-h);
  /* Hidden until physics places it, so nothing flashes at the corner. */
  opacity: 0;
  cursor: grab;
  touch-action: none;
  will-change: transform;
}
.pile-item.is-dragging {
  cursor: grabbing;
}
</style>
