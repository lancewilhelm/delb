import { defineStore } from "pinia";

export const useUiStore = defineStore(
  "ui",
  () => {
    const commandPaletteVisible = ref(false);
    function setCommandPaletteVisible(visible: boolean) {
      commandPaletteVisible.value = visible;
    }

    /**
     * Resizable left sidebar width (Collections sidebar).
     * Stored in pixels and persisted via Pinia persist.
     */
    const leftSidebarWidthPx = ref(260);

    function setLeftSidebarWidthPx(widthPx: number) {
      // Clamp to a reasonable range to avoid breaking layout.
      const min = 200;
      const max = 520;
      const next = Math.max(min, Math.min(max, Math.round(widthPx)));
      leftSidebarWidthPx.value = next;
    }

    function $reset() {
      // Insert reset logic here if needed
      leftSidebarWidthPx.value = 260;
    }

    return {
      commandPaletteVisible,
      setCommandPaletteVisible,

      leftSidebarWidthPx,
      setLeftSidebarWidthPx,

      $reset,
    };
  },
  {
    persist: true,
  },
);
