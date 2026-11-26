<script setup lang="ts">
import { useElementSize } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import DashboardArtMenu from '~/components/Dashboard/DashboardArtMenu.vue';
import DashboardCover from '~/components/Dashboard/DashboardCover.vue';
import DashboardPile from '~/components/Dashboard/DashboardPile.vue';
import { useWallDrift } from '~/composables/useWallDrift';
import { useBooksIndexFiltersStore } from '~/stores/booksIndexFilters';
import { useUiStore } from '~/stores/ui';
import {
  STATUS_LABELS,
  STATUS_ORDER,
  heroArtMode,
  statusSegments,
  wallBookIndex,
  wallDriftPxPerSecond,
  DEFAULT_WALL_DRIFT_SPEED,
  AUTO_LIBRARY_PILE,
  AUTO_LIBRARY_PILE_NARROW,
  pileCoverHeight,
  type LibraryArtStyle,
  type PileRegion,
  type PileSize,
  type WallMotion,
} from '~/utils/dashboardArt';
import type { DashboardBook, DashboardCounts } from '#shared/types/dashboard';

const props = defineProps<{
  counts: DashboardCounts | null;
  recent: DashboardBook[];
  /** Books per pile from the reader's settings; Auto shows fewer when narrow. */
  pileSize?: PileSize;
  /** A random sample for Pile art; without it the pile uses `recent`. */
  pileBooks?: {
    id: string;
    title: string;
    coverImagePath?: string | null;
    updatedAt?: string;
  }[];
  showStatusBar: boolean;
  /** Wall or Pile, from the reader's dashboard settings. */
  libraryArt: LibraryArtStyle;
  /** Whether the wall drifts (Appearance → Dashboard). */
  wallMotion: WallMotion;
  /** Drift speed level, 1–10. */
  wallDriftSpeed?: number;
}>();

const emit = defineEmits<{
  (e: 'set-art', style: LibraryArtStyle): void;
  /** A drifting wall is close to the end of the loaded covers. */
  (e: 'need-more'): void;
}>();

const artOptions = [
  { value: 'wall', label: 'Wall' },
  { value: 'pile', label: 'Pile' },
] as const;

const booksIndexFiltersStore = useBooksIndexFiltersStore();
const uiStore = useUiStore();

const total = computed(() => props.counts?.total ?? null);
// A pile looks natural at any size; the wall switches layout for small libraries.
const mode = computed(() => {
  if (!props.counts) return props.libraryArt;
  if (props.libraryArt === 'pile' && props.recent.length) return 'pile';
  return heroArtMode(props.recent.length);
});

// The pile stays clear of the text: to its right on wide cards, above it on narrow ones.
const card = ref<HTMLElement | null>(null);
const { width: cardWidth } = useElementSize(card);
const narrow = computed(() => cardWidth.value > 0 && cardWidth.value <= 640);
const pile = computed(() => {
  const auto = narrow.value ? AUTO_LIBRARY_PILE_NARROW : AUTO_LIBRARY_PILE;
  const source = props.pileBooks ?? props.recent;
  const books =
    (props.pileSize ?? 'auto') === 'auto' ? source.slice(0, auto) : source;
  return {
    books,
    coverHeight: pileCoverHeight(narrow.value ? 0.24 : 0.4, books.length, auto),
    region: (narrow.value
      ? { x0: 0, x1: 1, y0: 0.02, y1: 0.46 }
      : { x0: 0.46, x1: 1, y0: 0.04, y1: 1 }) satisfies PileRegion,
  };
});

// Big libraries: many small covers in reading order. Small ones: fewer, larger
// covers, repeated so a cover never touches a copy of itself.
const isWall = computed(
  () => mode.value === 'wall' || mode.value === 'wall-small',
);
const wallCols = computed(() => (mode.value === 'wall-small' ? 7 : 9));
const wallEl = ref<HTMLElement | null>(null);
const trackEl = ref<HTMLElement | null>(null);
const drift = useWallDrift({
  wall: wallEl,
  track: trackEl,
  cols: wallCols,
  enabled: computed(() => props.wallMotion === 'up' && isWall.value),
  pxPerSecond: computed(() =>
    wallDriftPxPerSecond(props.wallDriftSpeed ?? DEFAULT_WALL_DRIFT_SPEED),
  ),
});
// A drifting wall renders extra rows so new covers are ready before they show.
const wallRows = computed(() =>
  drift.active.value ? 7 : mode.value === 'wall-small' ? 4 : 5,
);
const wall = computed(() => {
  const small = mode.value === 'wall-small';
  const cols = wallCols.value;
  const start = drift.active.value ? drift.rowStart.value : 0;
  const slots: { key: string; book: DashboardBook }[] = [];
  // While the dashboard loads, the preferred art mode applies before any
  // covers arrive; an empty wall has nothing to repeat.
  if (!props.recent.length) return { cols, slots };
  for (let r = 0; r < wallRows.value; r++) {
    const row = start + r;
    for (let col = 0; col < cols; col++) {
      const index = wallBookIndex(row, col, cols, props.recent.length, small);
      slots.push({ key: `${row}:${col}`, book: props.recent[index]! });
    }
  }
  return { cols, slots };
});

// Ask for the next page of covers about three rows before the drift needs it.
watch(
  () => [drift.active.value, drift.rowStart.value, props.recent.length],
  () => {
    if (!drift.active.value || mode.value !== 'wall') return;
    const needed = (drift.rowStart.value + wallRows.value + 3) * wallCols.value;
    const total = props.counts?.total ?? 0;
    if (needed >= props.recent.length && props.recent.length < total)
      emit('need-more');
  },
  { immediate: true },
);
// A different collection starts its wall from the top.
watch(
  () => props.recent[0]?.id,
  () => drift.reset(),
);
const spotlightGhosts = computed(() => Math.max(0, 5 - props.recent.length));

const segments = computed(() =>
  props.counts ? statusSegments(props.counts) : [],
);
const chips = computed(() =>
  STATUS_ORDER.filter((key) => (props.counts?.[key] ?? 0) > 0).map((key) => ({
    key,
    label: STATUS_LABELS[key],
    count: props.counts![key],
    to: `/books?status=${key}`,
  })),
);
const statusSummary = computed(() =>
  segments.value
    .map((s) => `${STATUS_LABELS[s.key]} ${Math.round(s.percent)}%`)
    .join(', '),
);
const note = computed(() => {
  if (!props.counts) return '';
  if (mode.value === 'empty')
    return 'Add a book or import a folder and your covers will fill this card.';
  if (mode.value === 'spotlight')
    return 'A good start. Add a few more to fill the wall.';
  return '';
});
</script>

<template>
  <section
    ref="card"
    class="lib-card"
    :class="`mode-${mode}`"
    aria-labelledby="lib-card-title"
  >
    <div class="lib-art" aria-hidden="true">
      <template v-if="mode === 'pile'">
        <!-- Wait for the card's width, so a narrow card's pile drops only once. -->
        <DashboardPile
          v-if="cardWidth > 0"
          :books="pile.books"
          seed="all-books"
          :cover-height="pile.coverHeight"
          :region="pile.region"
        />
      </template>
      <div v-else-if="isWall" ref="wallEl" class="lib-wall">
        <div
          ref="trackEl"
          class="lib-wall-track"
          :style="{ '--cols': wall.cols }"
        >
          <DashboardCover
            v-for="slot in wall.slots"
            :key="slot.key"
            :book="slot.book"
          />
        </div>
      </div>
      <div v-else-if="mode === 'spotlight'" class="lib-spot">
        <DashboardCover
          v-for="(book, i) in recent"
          :key="book.id"
          :book="book"
          :style="{ '--r': `${[-6, 2, 7][i] ?? 0}deg` }"
        />
        <span v-for="n in spotlightGhosts" :key="`ghost-${n}`" class="lib-ghost"
          ><Icon name="lucide:plus"
        /></span>
      </div>
      <svg
        v-else
        class="lib-line-art"
        viewBox="0 0 320 210"
        preserveAspectRatio="xMidYMax meet"
      >
        <path d="M-40 196H360" />
        <g>
          <rect class="o" x="6" y="74" width="78" height="122" rx="4" />
          <path d="M14 182l22-32 16 20 11-12 19 24" />
          <circle cx="60.6" cy="108" r="6.2" />
        </g>
        <g>
          <rect class="o" x="96" y="52" width="86" height="144" rx="4" />
          <path d="M104 182l24-37 17 23 12-14 21 28" />
          <circle cx="156" cy="92" r="6.9" />
        </g>
        <g class="ac">
          <rect class="o" x="194" y="20" width="94" height="176" rx="4" />
          <path d="M202 182l26-46 19 28 13-18 23 35" />
          <circle cx="259.8" cy="69" r="7.5" />
        </g>
        <g transform="rotate(10 300 196)">
          <rect class="o" x="292" y="66" width="80" height="130" rx="4" />
        </g>
        <path class="fa" d="M-40 206H360" />
      </svg>
    </div>

    <div class="lib-label">
      <span class="lib-kicker">Your library</span>
      <h2 id="lib-card-title" class="lib-title">All books</h2>
      <p class="lib-total">
        <span>{{ total === null ? '—' : total.toLocaleString() }}</span>
        <small>{{ total === 1 ? 'book' : 'books' }}</small>
      </p>
      <p v-if="note" class="lib-note">{{ note }}</p>
      <div
        v-if="showStatusBar && segments.length"
        class="lib-status-bar"
        role="img"
        :aria-label="`Reading status: ${statusSummary}`"
      >
        <i
          v-for="segment in segments"
          :key="segment.key"
          :style="{
            width: `${segment.percent}%`,
            background: `var(--dash-s-${segment.key})`,
          }"
        ></i>
      </div>
      <nav v-if="chips.length" class="lib-chips" aria-label="Books by status">
        <RouterLink
          v-for="chip in chips"
          :key="chip.key"
          :to="chip.to"
          class="lib-chip"
          ><i :style="{ background: `var(--dash-s-${chip.key})` }"></i
          >{{ chip.label }} <b>{{ chip.count.toLocaleString() }}</b></RouterLink
        >
      </nav>
      <div class="lib-actions">
        <RouterLink
          v-if="mode === 'wall' || mode === 'wall-small' || mode === 'pile'"
          to="/books"
          class="lib-btn"
          @click="booksIndexFiltersStore.clearAll()"
          >Browse all books <Icon name="lucide:arrow-right"
        /></RouterLink>
        <template v-else-if="counts">
          <button
            type="button"
            class="lib-btn"
            @click="uiStore.setAddBookModalVisible(true)"
          >
            <Icon name="lucide:book-plus" /> Add books
          </button>
          <RouterLink
            v-if="total"
            to="/books"
            class="lib-btn ghost"
            @click="booksIndexFiltersStore.clearAll()"
            >Browse <Icon name="lucide:arrow-right"
          /></RouterLink>
        </template>
      </div>
    </div>
    <DashboardArtMenu
      v-if="total"
      label="Card art for All books"
      :options="artOptions"
      :value="libraryArt"
      @choose="(style) => style && emit('set-art', style)"
    />
  </section>
</template>

<style scoped>
.lib-card {
  position: relative;
  isolation: isolate;
  min-height: 350px;
  overflow: hidden;
  border-radius: 16px;
  background: var(--dash-tile-bg);
  border: 1px solid color-mix(in srgb, var(--sub-color) 32%, transparent);
  container-type: inline-size;
}
.lib-art {
  position: absolute;
  inset: 0;
  /* Its own stacking layer, below the text and the ⋯ menu. */
  z-index: 0;
  overflow: hidden;
}
.lib-wall {
  --cw: 92px;
  --gap: 14px;
  position: absolute;
  left: 30%;
  top: 50%;
  transform: translateY(-50%) rotate(-12deg);
}
.lib-wall-track {
  display: grid;
  grid-template-columns: repeat(var(--cols), var(--cw));
  gap: var(--gap);
  will-change: transform;
}
.mode-wall-small .lib-wall {
  --cw: 118px;
  --gap: 18px;
}
.lib-art:has(.lib-wall) {
  -webkit-mask: linear-gradient(90deg, transparent 26%, #000 52%);
  mask: linear-gradient(90deg, transparent 26%, #000 52%);
}
.lib-spot {
  position: absolute;
  right: 3%;
  top: 0;
  bottom: 0;
  width: 54%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
}
.lib-spot > .dash-cover {
  width: 118px;
  flex: none;
  transform: rotate(var(--r));
}
.lib-ghost {
  display: grid;
  place-items: center;
  flex: none;
  width: 118px;
  aspect-ratio: 2 / 3;
  border: 1.5px dashed color-mix(in srgb, var(--sub-color) 60%, transparent);
  border-radius: 4px 6px 6px 4px;
  color: var(--contrast-sub-color);
  font-size: 20px;
  opacity: 0.8;
}
.lib-line-art {
  position: absolute;
  right: 4%;
  top: 8%;
  bottom: 0;
  width: 50%;
  height: 92%;
  fill: none;
  stroke: var(--contrast-sub-color);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.lib-line-art .o {
  fill: var(--dash-tile-bg);
}
.lib-line-art .ac {
  stroke: var(--contrast-main-color);
}
.lib-line-art .fa {
  stroke: color-mix(in srgb, var(--sub-color) 60%, transparent);
  stroke-dasharray: 3 5;
}

.lib-label {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: 48%;
  min-height: 350px;
  padding: 30px 32px;
}
.lib-label > * {
  flex-shrink: 0;
}
.lib-kicker {
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--contrast-sub-color);
}
.lib-title {
  margin: 6px 0 0;
  font:
    400 30px/1.15 Georgia,
    'Times New Roman',
    serif;
  letter-spacing: -0.02em;
}
.lib-total {
  margin: 10px 0 4px;
  font:
    300 72px/1 Georgia,
    'Times New Roman',
    serif;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.lib-total small {
  margin-left: 8px;
  font-size: 18px;
  letter-spacing: 0;
  color: var(--contrast-sub-color);
}
.lib-note {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--contrast-sub-color);
}
.lib-status-bar {
  display: flex;
  gap: 2px;
  height: 8px;
  max-width: 380px;
  margin: 4px 0 10px;
  overflow: hidden;
  border-radius: 99px;
}
.lib-status-bar i {
  display: block;
  min-width: 3px;
  height: 100%;
}
.lib-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: auto;
}
.lib-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
  color: inherit;
  text-decoration: none;
  background: color-mix(in srgb, var(--bg-color) 55%, transparent);
  border: 1px solid color-mix(in srgb, var(--sub-color) 32%, transparent);
  backdrop-filter: blur(6px);
}
.lib-chip:hover {
  border-color: color-mix(in srgb, var(--sub-color) 80%, transparent);
}
.lib-chip i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.lib-chip b {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.lib-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.lib-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 13px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  background: var(--main-color);
  color: var(--bg-color);
}
.lib-btn.ghost {
  background: transparent;
  color: var(--contrast-text-color);
  border: 1px solid color-mix(in srgb, var(--sub-color) 60%, transparent);
}
.lib-card a:focus-visible,
.lib-card button:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 2px;
}

/* The ⋯ menu shows on hover/focus; touch screens always show it. */
.lib-card :deep(.art-menu) {
  top: 12px;
  right: 12px;
}
@media (hover: hover) {
  .lib-card :deep(.art-menu-trigger) {
    opacity: 0;
  }
  .lib-card:hover :deep(.art-menu-trigger),
  .lib-card:focus-within :deep(.art-menu-trigger),
  .lib-card :deep(.art-menu.is-open .art-menu-trigger) {
    opacity: 1;
  }
}

/* Narrow cards (phones, tight layouts): art on top, text below. A container
   query can't style its own container, so the label sets the card's height. */
@container (max-width: 640px) {
  .lib-art:has(.lib-wall) {
    -webkit-mask: linear-gradient(180deg, #000 30%, transparent 62%);
    mask: linear-gradient(180deg, #000 30%, transparent 62%);
  }
  .lib-wall {
    --cw: 64px;
    --gap: 10px;
    left: 50%;
    top: 22%;
    transform: translate(-50%, -50%) rotate(-12deg);
  }
  .mode-wall-small .lib-wall {
    --cw: 82px;
    --gap: 12px;
  }
  .lib-spot {
    left: 0;
    right: 0;
    width: auto;
    bottom: auto;
    height: 200px;
    gap: 10px;
  }
  .lib-spot > .dash-cover,
  .lib-ghost {
    width: 70px;
  }
  .lib-line-art {
    left: 10%;
    right: 10%;
    top: 16px;
    width: auto;
    height: 180px;
  }
  .lib-label {
    width: 100%;
    min-height: 420px;
    justify-content: flex-end;
    padding: 18px;
  }
  .lib-title {
    font-size: 22px;
  }
  .lib-total {
    font-size: 52px;
    margin: 4px 0;
  }
  .mode-pile .lib-label {
    min-height: 480px;
  }
  .lib-chips {
    margin-bottom: 0;
  }
  .lib-actions {
    margin-top: 14px;
  }
}
</style>
