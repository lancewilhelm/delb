<script setup lang="ts">
import { usePreferredReducedMotion } from '@vueuse/core';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import DashboardCover from '~/components/Dashboard/DashboardCover.vue';
import {
  pileLayout,
  type PilePlacement,
  type PileRegion,
} from '~/utils/dashboardArt';
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
/** Whether the books have dropped in yet; only the first layout drops them. */
let thrown = false;
/** Book IDs in the order their elements were handed to the physics. */
let placedIds: string[] = [];
/** Where each book lay when the last physics was released, by book ID. */
let resting = new Map<string, PilePlacement>();
/** The seed, size, and region of the current layout. */
let layoutKey = '';
/** Increases with each setup, so a slower earlier setup gives way. */
let setupRun = 0;

const bookKey = () => props.books.map((book) => book.id).join();
const currentLayoutKey = () =>
  [props.seed, props.coverHeight, JSON.stringify(props.region ?? null)].join(
    '|',
  );

function release() {
  if (!physics) return;
  resting = new Map();
  physics.positions().forEach((place, i) => {
    const id = placedIds[i];
    if (id) resting.set(id, place);
  });
  physics.dispose();
  physics = null;
}

/**
 * Lays the pile out. Only the first layout drops the books in. After that, a
 * change in which books show keeps the remaining books where they lie and
 * drops in only the new ones; a new seed, size, or region places every book
 * again without the drop.
 */
async function setup() {
  const run = ++setupRun;
  release();
  await nextTick();
  if (run !== setupRun) return;
  const el = box.value;
  if (!el || !el.clientWidth || !el.clientHeight) return;
  const ids = props.books.map((book) => book.id);
  const key = currentLayoutKey();
  const keepResting = thrown && key === layoutKey;
  const placements = pileLayout(ids, `${props.seed}:${throwId}`, {
    aspect: el.clientWidth / el.clientHeight,
    coverHeight: props.coverHeight,
    region: props.region,
  }).map((place, i): PilePlacement => {
    const rest = keepResting ? resting.get(ids[i]!) : undefined;
    if (rest) return { ...rest, drop: false };
    return { ...place, drop: !thrown || keepResting };
  });
  physics = attachPilePhysics(
    el,
    Array.from(el.querySelectorAll<HTMLElement>(':scope > .pile-item')),
    placements,
    { reducedMotion: reducedMotion.value === 'reduce', region: props.region },
  );
  thrown ||= ids.length > 0;
  placedIds = ids;
  layoutKey = key;
}

/** A drag inside a linked card must not also open it. */
function onClickCapture(event: MouseEvent) {
  if (physics?.consumeDrag()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

onMounted(setup);
// A string key, so a refresh that hands over equal books (new arrays and
// objects with the same IDs) does not count as a change.
watch(() => `${currentLayoutKey()}#${bookKey()}`, setup);
onBeforeUnmount(() => {
  ++setupRun;
  physics?.dispose();
  physics = null;
});
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
