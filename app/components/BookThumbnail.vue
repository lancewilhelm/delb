<script setup lang="ts">
defineOptions({ name: 'BookThumbnail' });

type BookThumb = {
  id: string;
  title: string;

  coverImagePath?: string | null;

  // Optional: used for subtitle display
  authors?: { id: string; name: string }[];
  authorNames?: string[];
  author?: string;

  // Optional: used by other views (not displayed by default)
  publisher?: { id: string; name: string } | null;
  series?: { id: string; name: string } | null;
  seriesIndex?: number | null;
};

const props = withDefaults(
  defineProps<{
    book: BookThumb;
    /** Show the author line (if present in `book`). Default: true */
    showAuthor?: boolean;
    /** Show the series line (if present in `book`). Default: true */
    showSeries?: boolean;
    /** Additional classes for the outer wrapper */
    class?: string;
    /** Lock the aspect ratio to 3:2 */
    lockAspectRatio?: boolean;

    /**
     * Selection mode (Phase 3):
     * - When true, clicks toggle selection instead of navigating.
     */
    selectable?: boolean;

    /** Whether this book is currently selected (only relevant when selectable=true). */
    selected?: boolean;
  }>(),
  {
    to: undefined,
    showAuthor: true,
    showSeries: true,
    class: '',
    lockAspectRatio: false,
    selectable: false,
    selected: false,
  },
);

const coverSrc = computed(() => {
  const p = props.book.coverImagePath;
  if (!p) return null;

  // Cover storage model:
  // - DB normally points to `.../thumb.webp` for list/grid usage
  // - Older data (or some imports) may point to a source cover like `.../cover.jpg` or `.../cover.source.jpg`
  // In those cases, prefer serving a sibling `thumb.webp` to keep list/grid views lightweight.
  const normalized = p.replace(/\\/g, '/');

  const base = normalized.replace(/^library\//, '');
  const lastSlash = base.lastIndexOf('/');
  const dir = lastSlash >= 0 ? base.slice(0, lastSlash) : '';
  const thumbRel = (dir ? `${dir}/` : '') + 'thumb.webp';

  const looksLikeSourceCover =
    /\/cover\.(jpe?g|png|webp|gif|svg)$/i.test(normalized) ||
    /\/cover\.source\.[^/]+$/i.test(normalized) ||
    /\/source\.[^/]+$/i.test(normalized);

  if (looksLikeSourceCover) {
    return `/api/media/covers/${thumbRel}`;
  }

  // API expects: /api/media/covers/<path under library>
  return `/api/media/covers/${base}`;
});

const authorLabel = computed(() => {
  const b = props.book;

  if (Array.isArray(b.authors) && b.authors.length > 0) {
    return b.authors
      .map((a) => a.name)
      .filter(Boolean)
      .join(', ');
  }

  if (Array.isArray(b.authorNames) && b.authorNames.length > 0) {
    return b.authorNames.filter(Boolean).join(', ');
  }

  return b.author ?? '';
});

const emit = defineEmits<{
  /** Fired when in selection mode and the user toggles selection for this book. */
  (e: 'toggle-select', bookId: string): void;
}>();

function onOpenBook() {
  if (props.selectable) {
    emit('toggle-select', props.book.id);
    return;
  }

  navigateTo(`/books/${props.book.id}`);
}

function onToggleSelect() {
  emit('toggle-select', props.book.id);
}
</script>

<template>
  <div :class="['w-43', props.class]">
    <div class="flex flex-col gap-1">
      <div class="relative">
        <BookCover
          :src="coverSrc"
          :alt="`Cover for ${props.book.title}`"
          :title="props.book.title"
          class="cursor-pointer"
          :class="lockAspectRatio ? 'aspect-2/3' : ''"
          @click="onOpenBook"
        />

        <!-- Selection overlay -->
        <div
          v-if="props.selectable"
          class="absolute inset-0 rounded-md pointer-events-none"
          :class="props.selected ? 'bg-(--sub-color)/25' : ''"
        />

        <!-- Selection toggle target -->
        <button
          v-if="props.selectable"
          type="button"
          class="absolute inset-0 rounded-md border border-transparent hover:border-(--sub-color)"
          :aria-pressed="props.selected ? 'true' : 'false'"
          :aria-label="props.selected ? 'Deselect book' : 'Select book'"
          @click.stop="onToggleSelect"
        >
          <span
            class="absolute top-2 right-2 w-6 h-6 rounded-full border flex items-center justify-center"
            :class="
              props.selected
                ? 'bg-(--main-color) border-(--main-color) text-(--bg-color)'
                : 'bg-(--bg-color)/80 border-(--sub-color) text-(--text-color)'
            "
          >
            <Icon :name="props.selected ? 'lucide:check' : ''" />
          </span>
        </button>
      </div>

      <div class="flex flex-col">
        <!-- Title -->
        <HoverScrollText>
          <span class="cursor-pointer hover:underline" @click="onOpenBook">
            {{ props.book.title }}
          </span>
        </HoverScrollText>

        <!-- Authors -->
        <HoverScrollText
          v-if="props.showAuthor && authorLabel"
          class="opacity-70 cursor-pointer"
        >
          <span v-if="props.selectable" @click="onOpenBook">
            {{ authorLabel }}
          </span>

          <template v-else>
            <span v-for="(a, index) in book.authors" :key="a.id">
              <span
                class="cursor-pointer hover:underline"
                @click="navigateTo(`/authors/${a.id}`)"
              >
                {{ a.name }}
              </span>
              <span v-if="book.authors && index < book.authors.length - 1"
                >,
              </span>
            </span>
          </template>
        </HoverScrollText>

        <!-- Series -->
        <HoverScrollText
          v-if="props.showSeries && props.book.series"
          class="italic opacity-70 text-sm cursor-pointer"
        >
          <div class="flex gap-1 hover:underline" @click="onOpenBook">
            {{ props.book.series.name }}
            <span v-if="props.book.seriesIndex"
              >#{{ props.book.seriesIndex }}</span
            >
          </div>
        </HoverScrollText>
      </div>
    </div>
  </div>
</template>
