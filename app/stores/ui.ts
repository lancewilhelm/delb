import { defineStore } from "pinia";

export const useUiStore = defineStore(
  "ui",
  () => {
    const commandPaletteVisible = ref(false);
    function setCommandPaletteVisible(visible: boolean) {
      commandPaletteVisible.value = visible;
    }

    function $reset() {
      // Insert reset logic here if needed
    }

    return {
      commandPaletteVisible,
      setCommandPaletteVisible,
      $reset,
    };
  },
  {
    persist: true,
  },
);
