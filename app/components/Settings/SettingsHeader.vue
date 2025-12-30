<script setup lang="ts">
const uiStore = useUiStore();
</script>

<template>
  <div class="flex justify-between py-2 px-4 items-center gap-4 app-header">
    <div class="flex gap-4 items-center app-header-left">
      <PageNavigation />
    </div>
    <div class="flex gap-4 items-center app-header-right">
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
