<script setup lang="ts">
import { computed } from 'vue';
import DashboardCover from '~/components/Dashboard/DashboardCover.vue';
import DashboardPile from '~/components/Dashboard/DashboardPile.vue';
import DashboardShelfArt from '~/components/Dashboard/DashboardShelfArt.vue';
import {
  AUTO_TILE_PILE,
  pileCoverHeight,
  wallSlots,
  type CardArtStyle,
} from '~/utils/dashboardArt';

type ArtBook = {
  id: string;
  title: string;
  coverImagePath?: string | null;
  updatedAt?: string;
  /** Set when the book has spine artwork. */
  spineRevision?: string | null;
  pages?: number | null;
  shelfWidth?: number | null;
  shelfHeight?: number | null;
};

const props = defineProps<{
  artStyle: CardArtStyle;
  books: ArtBook[];
  /** A random sample for Pile art, already sized; without it the pile uses the start of `books`. */
  pileBooks?: ArtBook[];
  /** Stable per-list key: seeds the pile so each list gets its own scatter. */
  seed: string;
}>();

// Each style shows a different number of covers.
const fan = computed(() => {
  const books = props.books.slice(0, 5);
  const mid = (books.length - 1) / 2;
  const spread = books.length > 3 ? 9 : 11;
  return books.map((book, i) => ({
    book,
    style: {
      '--x': `${(i - mid) * 13}cqh`,
      '--r': `${(i - mid) * spread}deg`,
      zIndex: 10 - Math.abs(Math.round(i - mid)),
    },
  }));
});

const STACK_POSES = [
  [-10, -7, 2],
  [8, 6, -2],
  [-5, -4, 3],
  [2, 0, 0],
] as const;
const stack = computed(() => {
  // First book on top: render it last.
  const books = props.books.slice(0, 4).reverse();
  const poses = STACK_POSES.slice(4 - books.length);
  return books.map((book, i) => ({
    book,
    style: {
      '--r': `${poses[i]![0]}deg`,
      '--dx': `${poses[i]![1]}cqw`,
      '--dy': `${poses[i]![2]}cqh`,
    },
  }));
});

const wall = computed(() => wallSlots(props.books, 5, 25));

const pile = computed(
  () => props.pileBooks ?? props.books.slice(0, AUTO_TILE_PILE),
);
</script>

<template>
  <div class="tile-art" :class="`art-${artStyle}`">
    <template v-if="artStyle === 'collage'">
      <div class="collage" :class="`n${Math.min(books.length, 3)}`">
        <DashboardCover
          v-for="book in books.slice(0, 3)"
          :key="book.id"
          :book="book"
        />
      </div>
    </template>

    <template v-else-if="artStyle === 'fan'">
      <DashboardCover
        v-for="item in fan"
        :key="item.book.id"
        :book="item.book"
        class="fan-item"
        :style="item.style"
      />
    </template>

    <template v-else-if="artStyle === 'stack'">
      <DashboardCover
        v-for="item in stack"
        :key="item.book.id"
        :book="item.book"
        class="stack-item"
        :style="item.style"
      />
    </template>

    <DashboardShelfArt v-else-if="artStyle === 'shelf'" :books="books" />

    <DashboardPile
      v-else-if="artStyle === 'pile'"
      :books="pile"
      :cover-height="pileCoverHeight(0.5, pile.length, AUTO_TILE_PILE)"
      :seed="seed"
    />

    <div v-else-if="artStyle === 'wall'" class="wall">
      <DashboardCover
        v-for="(book, i) in wall"
        :key="`${book.id}-${i}`"
        :book="book"
      />
    </div>
  </div>
</template>

<style scoped>
.tile-art {
  position: absolute;
  inset: 0;
  overflow: hidden;
  container-type: size;
}

/* Collage: one large + two small, two split, or one centered on a wash */
.collage {
  position: absolute;
  inset: 0;
  display: grid;
  gap: 3px;
  background: color-mix(in srgb, var(--sub-color) 32%, transparent);
}
.collage.n3 {
  grid-template-columns: 1.35fr 1fr;
  grid-template-rows: 1fr 1fr;
}
.collage.n3 > :first-child {
  grid-row: span 2;
}
.collage.n2 {
  grid-template-columns: 1fr 1fr;
}
.collage > .dash-cover {
  aspect-ratio: auto;
  width: 100%;
  height: 100%;
  border-radius: 0;
  box-shadow: none;
}
.collage.n1 {
  place-items: center;
  background: radial-gradient(
    circle at 50% 38%,
    color-mix(in srgb, var(--main-color) 22%, var(--sub-alt-color)),
    var(--sub-alt-color)
  );
}
.collage.n1 > .dash-cover {
  width: 50%;
  height: auto;
  aspect-ratio: 2 / 3;
  border-radius: 3px 5px 5px 3px;
  box-shadow: 0 12px 26px rgb(0 0 0 / 0.38);
}

/* Fan */
.fan-item {
  position: absolute;
  height: 72cqh;
  left: calc(50% - 24cqh + var(--x));
  top: 24cqh;
  transform: rotate(var(--r));
  transform-origin: 50% 130%;
  transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* Stack */
.stack-item {
  position: absolute;
  height: 80cqh;
  left: calc(50% - 26.7cqh + var(--dx));
  top: calc(11cqh + var(--dy));
  transform: rotate(var(--r));
  transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* Wall: the All books grid at tile size, one even gap */
.wall {
  position: absolute;
  left: 50%;
  top: 50%;
  display: grid;
  grid-template-columns: repeat(5, 24cqw);
  gap: 3.5cqw;
  transform: translate(-50%, -50%) rotate(-12deg);
  transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.wall > .dash-cover {
  box-shadow: 0 4px 10px rgb(0 0 0 / 0.28);
}
</style>
