<script setup lang="ts">
const uiStore = useUiStore();
</script>

<template>
  <div class="flex justify-between items-center h-[40px] z-10 app-header">
    <div
      class="flex items-center backdrop-blur bg-(--bg-color)/50 gap-4 p-4 rounded-br-2xl app-header-left z-20"
    >
      <PageNavigation />
    </div>
    <div
      class="flex gap-4 items-center backdrop-blur bg-(--bg-color)/50 p-4 rounded-bl-2xl justify-self-end app-header-right z-10"
    >
      <Icon
        name="lucide:command"
        class="text-(--main-color) cursor-pointer scale-125 header-icon"
        @click="
          uiStore.setCommandPaletteVisible(!uiStore.commandPaletteVisible)
        "
      />
    </div>
  </div>
</template>
