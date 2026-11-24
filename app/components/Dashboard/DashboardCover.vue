<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useUserSettingsStore } from '~/stores/userSettings';
import { buildBookCoverUrl } from '~/utils/covers';

/**
 * A lightweight, decorative cover for dashboard art. Books without a cover
 * image (or whose image fails to load) get Delb's generated title cover.
 */
const props = defineProps<{
  book: {
    id: string;
    title: string;
    /** `null` = known to have no cover; `undefined` = unknown, try the image. */
    coverImagePath?: string | null;
    updatedAt?: string;
  };
}>();

const userSettingsStore = useUserSettingsStore();
const failed = ref(false);
watch(
  () => props.book.id,
  () => {
    failed.value = false;
  },
);

const src = computed(() =>
  props.book.coverImagePath === null || failed.value
    ? null
    : buildBookCoverUrl({
        bookId: props.book.id,
        updatedAt: props.book.updatedAt,
      }),
);
const grayscale = computed(
  () => userSettingsStore.activeSettings.coverStyle.grayscale,
);
</script>

<template>
  <div class="dash-cover" :class="{ 'is-fallback': !src, grayscale }">
    <img
      v-if="src"
      :src="src"
      alt=""
      loading="lazy"
      decoding="async"
      draggable="false"
      @error="failed = true"
    />
    <span v-else class="dash-cover-title">{{ book.title }}</span>
  </div>
</template>

<style scoped>
.dash-cover {
  position: relative;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  border-radius: 3px 5px 5px 3px;
  background: color-mix(in srgb, var(--sub-alt-color) 75%, var(--bg-color));
  container-type: inline-size;
  box-shadow:
    0 6px 16px rgb(0 0 0 / 0.28),
    0 1px 2px rgb(0 0 0 / 0.3);
}
.dash-cover::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    rgb(0 0 0 / 0.28),
    transparent 6%,
    rgb(255 255 255 / 0.08) 8%,
    transparent 13%
  );
}
.dash-cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
}
.dash-cover.grayscale {
  filter: grayscale(1);
}
.dash-cover.is-fallback {
  display: grid;
  place-items: center;
  text-align: center;
  color: var(--contrast-text-color);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--sub-color) 32%, transparent),
    0 6px 16px rgb(0 0 0 / 0.22);
}
.dash-cover.is-fallback::before {
  content: '';
  position: absolute;
  left: 5cqw;
  top: 0;
  bottom: 0;
  width: 5cqw;
  border-left: 1.5cqw solid
    color-mix(in srgb, var(--sub-color) 60%, transparent);
  border-right: 1.5cqw solid
    color-mix(in srgb, var(--sub-color) 32%, transparent);
}
.dash-cover-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 5;
  line-clamp: 5;
  overflow: hidden;
  margin: 0 9cqw 0 15cqw;
  font:
    italic 400 12cqw/1.15 Georgia,
    'Times New Roman',
    serif;
  overflow-wrap: break-word;
}
</style>
