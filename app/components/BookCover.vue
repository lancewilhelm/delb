<script setup lang="ts">
type Props = {
  /**
   * Image URL/path to render (e.g. `/api/media/covers/.../cover.jpg`)
   */
  src?: string | null;

  /**
   * Alt text for the image.
   */
  alt?: string;

  /**
   * Title of the book.
   */
  title?: string;

  /**
   * If `true`, renders a placeholder when `src` is missing.
   * Defaults to `true`.
   */
  showPlaceholder?: boolean;

  /**
   * Optional extra classes to apply to the outer wrapper.
   */
  class?: string | undefined;
};

const props = withDefaults(defineProps<Props>(), {
  src: null,
  alt: 'Book cover',
  title: 'Book title',
  showPlaceholder: true,
  class: undefined,
});

const userSettingsStore = useUserSettingsStore();

// Vue will merge `class` on the root automatically, but we keep a prop for explicitness.
const hasSrc = computed(() => !!props.src);
</script>

<template>
  <div
    class="cover w-full h-full rounded-sm overflow-hidden background-transparent shadow-md"
    :class="[
      props.class,
      userSettingsStore.activeSettings.coverStyle.glossySpine ? 'gloss' : '',
      userSettingsStore.activeSettings.coverStyle.roundedRight
        ? 'rounded-r-2xl'
        : '',
      userSettingsStore.activeSettings.coverStyle.grayscale ? 'grayscale' : '',
    ]"
  >
    <img
      v-if="hasSrc"
      :src="props.src || undefined"
      :alt="props.alt"
      loading="lazy"
      draggable="false"
      class="w-full! h-full!"
    />
    <div
      v-else-if="props.showPlaceholder"
      class="flex w-full h-full bg-black/6 justify-center items-center font-serif italic p-4 text-center aspect-2/3"
    >
      {{ props.title }}
    </div>
  </div>
</template>

<style scoped>
/* Book Cover Effect */
.gloss::before {
  content: '';
  position: absolute;
  inset: 0px;
  border-radius: 3px;
  pointer-events: none;
  filter: contrast(310%) brightness(100%);
  box-shadow: rgba(15, 15, 15, 0.1) 0px 0px 0px 1px inset;
  background: linear-gradient(
    90deg,
    rgba(0, 0, 0, 0.118) 0.65%,
    rgba(255, 255, 255, 0.2) 1.53%,
    rgba(255, 255, 255, 0.1) 2.38%,
    rgba(0, 0, 0, 0.05) 3.26%,
    rgba(255, 255, 255, 0.14) 5.68%,
    rgba(244, 244, 244, 0) 6.96%
  );
}
</style>
