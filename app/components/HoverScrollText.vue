<script setup lang="ts">
interface Props {
  text?: string;
  pauseTime?: number; // Time to pause at start and end (ms)
  scrollSpeed?: number; // Speed at which to scroll (px/s)
}

const props = defineProps<Props>();
const outerContainer = ref<HTMLElement | null>(null);
const innerContainer = ref<HTMLElement | null>(null);
const isOverflowing = ref(false);
const scrollAmount = ref<number | null>(null);
const isScrolling = ref(false);
const animationTimer = ref<number | null>(null);
const scrollDurationMs = ref<number | null>(null);

const checkOverflow = async () => {
  await nextTick();
  if (!outerContainer.value || !innerContainer.value) return;

  const outer = outerContainer.value;
  const inner = innerContainer.value;
  isOverflowing.value = inner.scrollWidth > outer.clientWidth;

  if (isOverflowing.value) {
    // Calculate exact amount to scroll (just enough to see the hidden text)
    scrollAmount.value = inner.scrollWidth - outer.clientWidth;

    // scrollSpeed is px/s, but CSS transition duration expects ms.
    // durationSeconds = distancePx / speedPxPerSecond
    const speedPxPerSecond = props.scrollSpeed ?? 125;
    const safeSpeed = Math.max(1, speedPxPerSecond); // avoid divide-by-zero / negative speeds
    const durationMs = (scrollAmount.value / safeSpeed) * 1000;

    // Prevent ultra-fast, jarring animations for tiny overflows.
    scrollDurationMs.value = Math.max(250, Math.round(durationMs));
  } else {
    scrollAmount.value = null;
    scrollDurationMs.value = null;
  }
};

const handleMouseEnter = () => {
  if (
    isOverflowing.value &&
    innerContainer.value &&
    scrollAmount.value &&
    scrollDurationMs.value
  ) {
    const startAnimation = () => {
      isScrolling.value = true;
      const pauseTime = props.pauseTime ?? 1000;
      const durationMs = scrollDurationMs.value!;

      // Animate to end (showing the end of text)
      innerContainer.value!.style.transition = `transform ${durationMs}ms linear`;
      innerContainer.value!.style.transform = `translateX(-${scrollAmount.value}px)`;

      // After scroll duration + pause, scroll back to start
      animationTimer.value = window.setTimeout(() => {
        innerContainer.value!.style.transition = `transform ${durationMs}ms linear`;
        innerContainer.value!.style.transform = 'translateX(0)';

        // Restart the cycle after returning to start position
        animationTimer.value = window.setTimeout(() => {
          animationTimer.value = window.setTimeout(startAnimation, pauseTime);
        }, durationMs);
      }, durationMs + pauseTime);
    };

    // Start animation sequence after initial delay
    animationTimer.value = window.setTimeout(startAnimation, 500);
  }
};

const handleMouseLeave = () => {
  if (animationTimer.value) {
    clearTimeout(animationTimer.value);
    animationTimer.value = null;
  }

  if (innerContainer.value) {
    // Immediately return to start position
    innerContainer.value.style.transition = 'transform 300ms ease-out';
    innerContainer.value.style.transform = 'translateX(0)';
    isScrolling.value = false;
  }
};

onMounted(() => {
  checkOverflow();
  window.addEventListener('resize', checkOverflow);
});

// Recalculate when content changes
watch(() => props.text, checkOverflow);

// Clean up
onUnmounted(() => {
  window.removeEventListener('resize', checkOverflow);
  if (animationTimer.value) {
    clearTimeout(animationTimer.value);
  }
});
</script>

<template>
  <span
    ref="outerContainer"
    class="scrollable-outer"
    :class="{ 'with-ellipsis': !isScrolling }"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <span ref="innerContainer" class="scrollable-inner">
      <slot>{{ text }}</slot>
    </span>
  </span>
</template>

<style scoped>
.scrollable-outer {
  display: inline-block;
  overflow: hidden;
  max-width: 100%;
  white-space: nowrap;
}

.with-ellipsis {
  text-overflow: ellipsis;
}

.scrollable-inner {
  display: inline-block;
  white-space: nowrap;
}
</style>
