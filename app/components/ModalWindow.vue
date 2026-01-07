<script setup lang="ts">
defineProps<{
  open: boolean;
}>();

const emit = defineEmits(['close']);

/**
 * Prevent "click-drag to select text inside modal, release outside" from closing the modal.
 * We only close when the pointer interaction *starts* on the backdrop itself.
 */
let closeOnPointerUp = false;

function onBackdropPointerDown(event: PointerEvent) {
  // Only consider it a backdrop interaction if it began on the backdrop element itself,
  // not on children (the modal content).
  closeOnPointerUp = event.target === event.currentTarget;
}

function onBackdropClick() {
  if (closeOnPointerUp) {
    emit('close');
  }
  closeOnPointerUp = false;
}

// Add event listener for escape key to close the modal
onMounted(() => {
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      emit('close');
    }
  };

  window.addEventListener('keydown', handleKeydown);

  // Cleanup the event listener on component unmount
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleKeydown);
  });
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed top-0 left-0 w-full h-full bg-black/50 flex items-center justify-center z-50"
      @pointerdown="onBackdropPointerDown"
      @click="onBackdropClick"
    >
      <div
        class="bg-(--bg-color) border border-(--main-color) m-4 md:max-w-[80%] lg:max-w-[60%] p-4 rounded-lg shadow-lg"
        @click.stop
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>
