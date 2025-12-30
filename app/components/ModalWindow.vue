<script setup lang="ts">
defineProps<{
  open: boolean;
}>();

// Add event listener for escape key to close the modal
onMounted(() => {
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      emit("close");
    }
  };

  window.addEventListener("keydown", handleKeydown);

  // Cleanup the event listener on component unmount
  onBeforeUnmount(() => {
    window.removeEventListener("keydown", handleKeydown);
  });
});

const emit = defineEmits(["close"]);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed top-0 left-0 w-full h-full bg-black/50 flex items-center justify-center z-50"
      @click="emit('close')"
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
