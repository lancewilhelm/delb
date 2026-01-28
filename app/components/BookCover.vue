<script setup lang="ts">
type Props = {
  /**
   * Image URL/path to render (e.g. `/api/media/covers/.../cover.jpg`)
   */
  src?: string | null;

  /**
   * Optional fallback URL/path to use if `src` fails to load.
   */
  fallbackSrc?: string | null;

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
   * If `true`, displays the cover resolution (WxH) in the corner after load.
   * Defaults to `false`.
   */
  showResolution?: boolean;

  /**
   * Optional extra classes to apply to the outer wrapper.
   */
  class?: string | undefined;
};

const props = withDefaults(defineProps<Props>(), {
  src: null,
  fallbackSrc: null,
  alt: 'Book cover',
  title: 'Book title',
  showPlaceholder: true,
  showResolution: false,
  class: undefined,
});

const userSettingsStore = useUserSettingsStore();

// Vue will merge `class` on the root automatically, but we keep a prop for explicitness.
const activeSrc = ref<string | null>(props.src ?? null);
const dimensions = ref<{ width: number; height: number } | null>(null);

watch(
  () => props.src,
  (next) => {
    activeSrc.value = next ?? null;
    dimensions.value = null;
  },
);

function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement | null;
  if (!img) return;

  const width = img.naturalWidth || 0;
  const height = img.naturalHeight || 0;
  if (width > 0 && height > 0) {
    dimensions.value = { width, height };
  }
}

function onImgError() {
  if (!props.fallbackSrc) return;
  if (!activeSrc.value) return;
  if (activeSrc.value === props.fallbackSrc) return;

  activeSrc.value = props.fallbackSrc;
  dimensions.value = null;
}

const hasSrc = computed(() => !!activeSrc.value);
const resolutionLabel = computed(() => {
  const d = dimensions.value;
  if (!d) return null;
  return `${d.width}×${d.height}`;
});
</script>

<template>
  <div
    class="relative w-full h-full rounded-sm overflow-hidden background-transparent shadow-md cover"
    :class="[
      props.class,
      userSettingsStore.activeSettings.coverStyle.glossySpine ? 'gloss' : '',
      userSettingsStore.activeSettings.coverStyle.roundedRight
        ? 'rounded-r-2xl'
        : '',
      userSettingsStore.activeSettings.coverStyle.grayscale ? 'grayscale' : '',
    ]"
  >
    <template v-if="hasSrc">
      <img
        :src="activeSrc || undefined"
        :alt="props.alt"
        loading="lazy"
        draggable="false"
        class="w-full! h-full! object-cover"
        @load="onImgLoad"
        @error="onImgError"
      />
      <div
        v-if="props.showResolution && resolutionLabel"
        class="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white leading-none z-10 pointer-events-none select-none"
      >
        {{ resolutionLabel }}
      </div>
    </template>

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
