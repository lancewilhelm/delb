<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import BookCover from '~/components/BookCover.vue';
import { useBookReadingStatusMenu } from '~/composables/useBookReadingStatusMenu';
import type { BookStatusChange } from '~/utils/bookReadingStatus';
import { buildBookCoverUrl } from '~/utils/covers';
import type { DashboardBook } from '#shared/types/dashboard';

const props = defineProps<{ book: DashboardBook }>();
const emit = defineEmits<{
  (e: 'status-change', change: BookStatusChange): void;
}>();

// The cover keeps the same Reading status menu as grid and list covers.
const { getReadingStatusMenuItem } = useBookReadingStatusMenu({
  bookId: () => props.book.id,
  bookTitle: () => props.book.title,
  onChanged: (change) => emit('status-change', change),
});
const menuItems = async () => [await getReadingStatusMenuItem()];

const coverSrc = computed(() =>
  props.book.coverImagePath
    ? buildBookCoverUrl({
        bookId: props.book.id,
        updatedAt: props.book.updatedAt,
      })
    : null,
);
const progress = computed(() =>
  typeof props.book.progress === 'number' ? props.book.progress : null,
);
</script>

<template>
  <RouterLink
    :to="`/books/${encodeURIComponent(book.id)}`"
    class="continue-card"
  >
    <span class="continue-cover">
      <BookCover
        :src="coverSrc"
        :title="book.title"
        alt=""
        :context-menu-items="menuItems"
      />
    </span>
    <span class="continue-meta">
      <span class="continue-title">{{ book.title }}</span>
      <span class="continue-progress">
        <span class="continue-track"
          ><span :style="{ width: `${Math.min(100, progress ?? 0)}%` }"
        /></span>
        {{ progress === null ? 'Not started' : `${progress.toFixed(1)}%` }}
      </span>
    </span>
  </RouterLink>
</template>

<style scoped>
.continue-card {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  padding: 12px;
  border-radius: 14px;
  color: inherit;
  text-decoration: none;
  background: var(--dash-tile-bg);
  border: 1px solid color-mix(in srgb, var(--sub-color) 32%, transparent);
}
.continue-card:hover {
  border-color: color-mix(in srgb, var(--sub-color) 70%, transparent);
}
.continue-card:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 4px;
}
.continue-cover {
  flex: none;
  width: 62px;
  aspect-ratio: 2 / 3;
  font-size: 9px;
}
.continue-meta {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.continue-title {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.continue-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--contrast-sub-color);
}
.continue-track {
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: 9px;
  background: color-mix(in srgb, var(--sub-color) 32%, transparent);
}
.continue-track > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--main-color);
}
</style>
