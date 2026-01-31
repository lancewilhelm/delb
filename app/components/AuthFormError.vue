<script setup lang="ts">
withDefaults(
  defineProps<{
    message: string;
    /**
     * Reserve vertical space so the form doesn't jump when the message appears.
     */
    minHeightRem?: number;
  }>(),
  {
    minHeightRem: 4,
  },
);
</script>

<template>
  <div
    class="relative w-full flex justify-center mt-4"
    :style="{ minHeight: `${minHeightRem}rem` }"
    aria-live="polite"
    aria-atomic="true"
  >
    <Transition name="fade">
      <div
        v-if="message"
        class="absolute top-0 px-4 py-3 rounded border border-(--error-color) bg-(--error-color)/10 text-(--error-color) max-w-[320px] text-center text-sm"
        role="alert"
      >
        {{ message }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
