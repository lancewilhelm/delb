<script setup lang="ts">
const props = defineProps<{ open: boolean; label: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
watch(
  () => props.open,
  (open) => {
    if (open)
      previousFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    else {
      previousFocus?.focus();
      previousFocus = null;
    }
  },
  { flush: 'sync' },
);
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = Array.from(
    dialog.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
    ) ?? [],
  );
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  const index = controls.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    controls.at(-1)?.focus();
  } else if (
    !event.shiftKey &&
    (index === -1 || index === controls.length - 1)
  ) {
    event.preventDefault();
    controls[0]?.focus();
  }
}
</script>
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed top-0 left-0 w-full h-full flex items-center justify-center z-5000 bg-black/20"
      @click="emit('close')"
    >
      <div
        ref="dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="label"
        class="flex flex-col backdrop-blur-lg bg-(--bg-color)/80 w-180 h-150 max-h-[calc(100dvh-2rem)] m-4 md:max-w-[80%] lg:max-w-[60%] rounded-lg shadow-lg border border-(--contrast-border-color) overflow-hidden"
        @keydown="onKeydown"
        @click.stop
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>
