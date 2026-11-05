<script setup lang="ts">
// Only Continue reading uses live books. The two proposed shelves are samples.
import { computed, ref } from 'vue';

type ShelfMode = 'reading' | 'recent' | 'favorites';
const props = defineProps<{
  variant: string;
  books: {
    id: string;
    title: string;
    coverImagePath?: string | null;
    progress?: number | null;
  }[];
  initialShelf?: ShelfMode;
  empty?: boolean;
}>();

const mode = ref<ShelfMode>(props.initialShelf ?? 'reading');
const choices = [
  { key: 'reading', label: 'Continue reading' },
  { key: 'recent', label: 'Recently read' },
  { key: 'favorites', label: 'Favorites' },
] satisfies { key: ShelfMode; label: string }[];

const sampleBooks = [
  {
    id: 'sample-1',
    title: 'Piranesi',
    author: 'Susanna Clarke',
    finishedAt: '2026-11-02',
    favorite: true,
    color: '#87938a',
    ink: '#202c2a',
  },
  {
    id: 'sample-2',
    title: 'A Psalm for the Wild-Built',
    author: 'Becky Chambers',
    finishedAt: '2026-10-26',
    favorite: true,
    color: '#c4b385',
    ink: '#34352e',
  },
  {
    id: 'sample-3',
    title: 'The Dispossessed',
    author: 'Ursula K. Le Guin',
    finishedAt: '2026-10-18',
    favorite: false,
    color: '#8c898f',
    ink: '#f3eee4',
  },
  {
    id: 'sample-4',
    title: 'The Old Man and the Sea',
    author: 'Ernest Hemingway',
    finishedAt: '2026-10-08',
    favorite: true,
    color: '#7e9aab',
    ink: '#1e303a',
  },
];

const recentBooks = [...sampleBooks].sort((a, b) =>
  b.finishedAt.localeCompare(a.finishedAt),
);
const samples = computed(() =>
  props.empty
    ? []
    : mode.value === 'favorites'
      ? sampleBooks
          .filter((book) => book.favorite)
          .sort((a, b) => a.title.localeCompare(b.title))
      : recentBooks,
);
const subtitle = computed(() => {
  if (mode.value === 'reading') return 'Pick up where you left off';
  if (mode.value === 'recent') return 'Date read · newest first';
  return 'Books you want to keep close';
});
const viewAll = computed(() =>
  mode.value === 'reading' ? '/books?status=reading' : '/books?status=finished',
);

function readDate(date: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}
</script>

<template>
  <section
    class="study-choice-shelf"
    :class="`study-shelf-${variant}`"
    aria-label="Your books"
  >
    <div class="study-shelf-toolbar">
      <div
        v-if="variant === 'D'"
        class="study-shelf-tabs"
        role="group"
        aria-label="Choose book shelf"
      >
        <button
          v-for="choice in choices"
          :key="choice.key"
          type="button"
          :aria-pressed="mode === choice.key"
          @click="mode = choice.key"
        >
          {{ choice.label }}
        </button>
      </div>

      <label v-else-if="variant === 'E'" class="study-shelf-dropdown">
        <span class="study-shelf-sr">Choose book shelf</span>
        <select v-model="mode">
          <option
            v-for="choice in choices"
            :key="choice.key"
            :value="choice.key"
          >
            {{ choice.label }}
          </option>
        </select>
      </label>

      <template v-else>
        <h2>Your books</h2>
        <div
          class="study-shelf-segments"
          role="group"
          aria-label="Choose book shelf"
        >
          <button
            v-for="choice in choices"
            :key="choice.key"
            type="button"
            :aria-pressed="mode === choice.key"
            @click="mode = choice.key"
          >
            {{ choice.label }}
          </button>
        </div>
      </template>

      <NuxtLink
        v-if="mode !== 'favorites'"
        :to="viewAll"
        class="study-shelf-view-all"
        >View all</NuxtLink
      >
    </div>

    <p class="study-shelf-subtitle" aria-live="polite">{{ subtitle }}</p>

    <template v-if="mode === 'reading'">
      <p v-if="!books.length" class="study-shelf-empty">
        No books marked as Reading.
      </p>
      <div v-else class="study-reading-shelf">
        <div v-for="book in books" :key="book.id" class="study-reading-book">
          <BookThumbnail :book="book" :lock-aspect-ratio="true" />
          <div class="study-reading-progress">
            {{
              typeof book.progress === 'number'
                ? `${book.progress.toFixed(1)}%`
                : '—'
            }}
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <p v-if="!samples.length" class="study-shelf-empty">
        {{
          mode === 'favorites'
            ? 'No favorites yet. Star a book to keep it here.'
            : 'Finished books will appear here, newest first.'
        }}
      </p>
      <div v-else class="study-reading-shelf">
        <div v-for="book in samples" :key="book.id" class="study-reading-book">
          <div
            class="study-sample-cover"
            :style="{ background: book.color, color: book.ink }"
            :aria-label="`Sample cover for ${book.title}`"
            role="img"
          >
            <span
              v-if="mode === 'favorites'"
              class="study-sample-favorite"
              aria-label="Favorite"
              >★</span
            >
            <span class="study-sample-author">{{ book.author }}</span>
            <span class="study-sample-title">{{ book.title }}</span>
            <span class="study-sample-circle" aria-hidden="true">◯</span>
          </div>
          <div class="study-sample-book-title" :title="book.title">
            {{ book.title }}
          </div>
          <div class="study-reading-progress">
            {{
              mode === 'recent'
                ? `Read ${readDate(book.finishedAt)}`
                : book.author
            }}
          </div>
        </div>
      </div>
      <p class="study-shelf-sample-note">
        Sample books ·
        {{
          mode === 'favorites' ? 'Favorites concept' : 'Recently read concept'
        }}
      </p>
    </template>
  </section>
</template>

<style>
.study-choice-shelf {
  min-width: 0;
}
.study-shelf-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.study-shelf-tabs {
  display: flex;
  gap: 26px;
  min-width: 0;
}
.study-shelf-tabs button,
.study-shelf-segments button {
  font: inherit;
  color: var(--text-color);
  background: transparent;
  border: 0;
  cursor: pointer;
  border-radius: 0;
}
.study-shelf-tabs button {
  padding: 8px 0 12px;
  border-bottom: 2px solid transparent;
  font-size: 14px;
  opacity: 0.55;
  white-space: nowrap;
}
.study-shelf-tabs button[aria-pressed='true'] {
  border-color: var(--main-color);
  opacity: 1;
  font-weight: 500;
}
.study-shelf-tabs button:hover,
.study-shelf-segments button:hover {
  background: transparent;
  opacity: 1;
}
.study-shelf-view-all {
  color: inherit;
  opacity: 0.65;
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
  margin-left: auto;
}
.study-shelf-view-all:hover {
  text-decoration: underline;
}
.study-shelf-subtitle {
  font-size: 12px;
  opacity: 0.6;
  margin: 12px 0 20px;
}
.study-shelf-dropdown select {
  appearance: auto;
  padding: 4px 4px 4px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-color);
  font:
    500 18px/1.5 'Geist',
    system-ui,
    sans-serif;
  cursor: pointer;
}
.study-shelf-dropdown option {
  background: var(--bg-color);
  color: var(--text-color);
  font-size: 14px;
}
.study-shelf-segments {
  display: flex;
  padding: 3px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--sub-color) 14%, transparent);
}
.study-shelf-segments button {
  padding: 7px 11px;
  font-size: 12px;
  border-radius: 5px;
  opacity: 0.6;
  white-space: nowrap;
}
.study-shelf-segments button[aria-pressed='true'] {
  background: var(--sub-alt-color);
  color: var(--main-color);
  opacity: 1;
  box-shadow: 0 1px 4px #0001;
}
.study-shelf-F .study-shelf-subtitle {
  margin-top: 18px;
}
.study-shelf-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.study-shelf-empty {
  padding: 32px 0;
  font-size: 13px;
  opacity: 0.65;
}
.study-shelf-sample-note {
  margin: 16px 0 0;
  font-size: 10px;
  opacity: 0.45;
}
.study-shelf-toolbar button:focus-visible,
.study-shelf-toolbar select:focus-visible,
.study-shelf-view-all:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 4px;
}
.study-sample-cover {
  position: relative;
  aspect-ratio: 2/3;
  border-radius: 5px;
  padding: 20px 12px 12px;
  box-shadow: inset 3px 0 5px #0002;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.study-sample-author {
  font:
    8px/1.5 system-ui,
    sans-serif;
  text-transform: uppercase;
  letter-spacing: 1.3px;
  padding-right: 8px;
}
.study-sample-title {
  font:
    23px/1.1 Georgia,
    serif;
  margin-top: 18px;
  overflow-wrap: anywhere;
}
.study-sample-circle {
  font:
    90px/1 Georgia,
    serif;
  margin-top: auto;
  align-self: center;
  opacity: 0.35;
}
.study-sample-favorite {
  position: absolute;
  top: 5px;
  right: 8px;
  font-size: 14px;
}
.study-sample-book-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 7px;
  font-size: 12px;
}
@media (max-width: 700px) {
  .study-shelf-tabs {
    gap: 18px;
  }
  .study-shelf-tabs button {
    font-size: 12px;
  }
  .study-shelf-D .study-shelf-toolbar {
    flex-wrap: wrap;
    gap: 0;
  }
  .study-shelf-F .study-shelf-toolbar {
    flex-wrap: wrap;
    gap: 12px;
  }
  .study-shelf-F .study-shelf-toolbar > h2 {
    width: 100%;
  }
  .study-shelf-segments {
    max-width: 100%;
  }
  .study-shelf-segments button {
    padding: 7px 9px;
    font-size: 11px;
  }
}
</style>
