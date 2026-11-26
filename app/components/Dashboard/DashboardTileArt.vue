<script setup lang="ts">
import { computed, ref } from 'vue';
import { useUserSettingsStore } from '~/stores/userSettings';
import DashboardCover from '~/components/Dashboard/DashboardCover.vue';
import DashboardPile from '~/components/Dashboard/DashboardPile.vue';
import { hashString, wallSlots, type CardArtStyle } from '~/utils/dashboardArt';

type ArtBook = {
  id: string;
  title: string;
  coverImagePath?: string | null;
  updatedAt?: string;
  finishedDate?: string | null;
  /** Set when the book has spine artwork. */
  spineRevision?: string | null;
};

const props = defineProps<{
  artStyle: CardArtStyle;
  books: ArtBook[];
  /** A random sample for Pile art; without it the pile uses `books`. */
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

const SPINE_COLORS = [
  '#425d49',
  '#a16855',
  '#a67d45',
  '#657b82',
  '#9b604c',
  '#6c765b',
  '#455d72',
  '#83715f',
];
const SPINE_SIZES = [
  [78, 12],
  [66, 10],
  [72, 14],
  [62, 11],
] as const;
const userSettingsStore = useUserSettingsStore();
const grayscale = computed(
  () => userSettingsStore.activeSettings.coverStyle.grayscale,
);
// Spine art that failed to load falls back to a generated colored spine.
const failedSpines = ref(new Set<string>());
function onSpineError(bookId: string) {
  failedSpines.value = new Set(failedSpines.value).add(bookId);
}

const shelf = computed(() => {
  const [first, ...rest] = props.books.slice(0, 5);
  return {
    first,
    sticker: first?.finishedDate ? shortDate(first.finishedDate) : null,
    spines: rest.map((book, i) => {
      const art =
        book.spineRevision && !failedSpines.value.has(book.id)
          ? `/api/books/${encodeURIComponent(book.id)}/spine?v=${encodeURIComponent(book.spineRevision)}`
          : null;
      return {
        book,
        art,
        lean: i === rest.length - 1 && rest.length > 2,
        // Spine art keeps its own proportions; generated spines use set widths.
        style: art
          ? { height: `${SPINE_SIZES[i]![0]}cqh` }
          : {
              height: `${SPINE_SIZES[i]![0]}cqh`,
              width: `${SPINE_SIZES[i]![1]}cqw`,
              backgroundColor:
                SPINE_COLORS[hashString(book.id) % SPINE_COLORS.length],
            },
      };
    }),
  };
});

const wall = computed(() => wallSlots(props.books, 5, 25));

const pile = computed(() => (props.pileBooks ?? props.books).slice(0, 10));

function shortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
}
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

    <div v-else-if="artStyle === 'shelf'" class="shelf-row">
      <span v-if="shelf.first" class="shelf-face">
        <DashboardCover :book="shelf.first" />
        <span v-if="shelf.sticker" class="shelf-sticker">{{
          shelf.sticker
        }}</span>
      </span>
      <span
        v-for="spine in shelf.spines"
        :key="spine.book.id"
        class="shelf-spine"
        :class="{ lean: spine.lean, 'has-art': spine.art, grayscale }"
        :style="spine.style"
        ><img
          v-if="spine.art"
          :src="spine.art"
          alt=""
          loading="lazy"
          decoding="async"
          draggable="false"
          @error="onSpineError(spine.book.id)"
        /><span v-else>{{ spine.book.title }}</span></span
      >
    </div>

    <DashboardPile v-else-if="artStyle === 'pile'" :books="pile" :seed="seed" />

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

/* Shelf: first book face-out, the rest as spines on a ledge */
.art-shelf::after {
  content: '';
  position: absolute;
  inset: auto 0 0;
  height: 11cqh;
  background: color-mix(in srgb, var(--sub-color) 40%, var(--sub-alt-color));
  box-shadow: 0 -1px 0 color-mix(in srgb, var(--sub-color) 60%, transparent);
}
.shelf-row {
  position: absolute;
  inset: 13cqh 3cqw 11cqh;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 1.2cqw;
}
.shelf-face {
  position: relative;
  flex: none;
  height: 76cqh;
  margin-right: 2cqw;
}
.shelf-face > .dash-cover {
  height: 100%;
}
.shelf-sticker {
  position: absolute;
  z-index: 2;
  top: -2cqh;
  right: -5cqw;
  transform: rotate(8deg);
  padding: 3px 5px;
  border-radius: 4px;
  background: var(--main-color);
  color: var(--bg-color);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.25);
}
.shelf-spine {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 2px 2px 1px 1px;
  color: #f4efe6;
  background-image: linear-gradient(
    90deg,
    rgb(0 0 0 / 0.28),
    transparent 22%,
    rgb(255 255 255 / 0.1) 48%,
    transparent 70%,
    rgb(0 0 0 / 0.3)
  );
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.25);
  transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.shelf-spine > span {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  max-height: 80%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font:
    600 10px/1 Georgia,
    serif;
}
.shelf-spine.has-art {
  background-image: none;
}
.shelf-spine.has-art > img {
  display: block;
  height: 100%;
  width: auto;
  max-width: 24cqw;
  object-fit: cover;
}
.shelf-spine.grayscale {
  filter: grayscale(1);
}
.shelf-spine.lean {
  transform: rotate(9deg);
  transform-origin: 100% 100%;
  margin-left: 4cqw;
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
