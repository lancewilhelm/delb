<script setup lang="ts">
interface Props {
  text?: string;
  pauseTime?: number; // Time to pause at start and end (ms)
  scrollDuration?: number; // Time to scroll (ms)
}

const props = defineProps<Props>();
const outerContainer = ref<HTMLElement | null>(null);
const innerContainer = ref<HTMLElement | null>(null);
const isOverflowing = ref(false);
const scrollAmount = ref<number | null>(null);
const isScrolling = ref(false);
const animationTimer = ref<number | null>(null);

const checkOverflow = async () => {
  await nextTick();
  if (!outerContainer.value || !innerContainer.value) return;

  const outer = outerContainer.value;
  const inner = innerContainer.value;
  isOverflowing.value = inner.scrollWidth > outer.clientWidth;

  if (isOverflowing.value) {
    // Calculate exact amount to scroll (just enough to see the hidden text)
    scrollAmount.value = inner.scrollWidth - outer.clientWidth;
  } else {
    scrollAmount.value = null;
  }
};

const handleMouseEnter = () => {
  if (isOverflowing.value && innerContainer.value && scrollAmount.value) {
    const startAnimation = () => {
      isScrolling.value = true;
      const pauseTime = props.pauseTime || 1000;
      const scrollDuration = props.scrollDuration || 1000;

      // Animate to end (showing the end of text)
      innerContainer.value!.style.transition = `transform ${scrollDuration}ms ease-out`;
      innerContainer.value!.style.transform = `translateX(-${scrollAmount.value}px)`;

      // After scroll duration + pause, scroll back to start
      animationTimer.value = window.setTimeout(() => {
        innerContainer.value!.style.transition = `transform ${scrollDuration}ms ease-out`;
        innerContainer.value!.style.transform = "translateX(0)";

        // Reset after scrolling back, then restart the cycle
        animationTimer.value = window.setTimeout(() => {
          // Restart the cycle after returning to start position
          animationTimer.value = window.setTimeout(startAnimation, pauseTime);
        }, scrollDuration);
      }, scrollDuration + pauseTime);
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
    innerContainer.value.style.transition = "transform 300ms ease-out";
    innerContainer.value.style.transform = "translateX(0)";
    isScrolling.value = false;
  }
};

onMounted(() => {
  checkOverflow();
  window.addEventListener("resize", checkOverflow);
});

// Recalculate when content changes
watch(() => props.text, checkOverflow);

// Clean up
onUnmounted(() => {
  window.removeEventListener("resize", checkOverflow);
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
