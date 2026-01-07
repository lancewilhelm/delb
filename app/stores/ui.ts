import { defineStore } from 'pinia';

export type LibraryView = 'books' | 'authors' | 'series' | 'publishers';

export const useUiStore = defineStore(
  'ui',
  () => {
    /**
     * Command Pallete visibility
     */
    const commandPaletteVisible = ref(false);
    function setCommandPaletteVisible(visible: boolean) {
      commandPaletteVisible.value = visible;
    }

    /**
     * Header "View" selection state.
     * This controls *what* the user is looking at (Books/Authors/Series/Publishers).
     */
    const libraryView = ref<LibraryView>('books');
    function setLibraryView(view: LibraryView) {
      libraryView.value = view;
    }

    /**
     * Left sidebar (Collections sidebar) UI state.
     * Stored in pixels and persisted via Pinia persist.
     */
    const leftSidebarWidthPx = ref(260);
    const leftSidebarCollapsed = ref(false);

    function setLeftSidebarWidthPx(widthPx: number) {
      // Clamp to a reasonable range to avoid breaking layout.
      const min = 200;
      const max = 520;
      const next = Math.max(min, Math.min(max, Math.round(widthPx)));
      leftSidebarWidthPx.value = next;
    }

    function setLeftSidebarCollapsed(collapsed: boolean) {
      leftSidebarCollapsed.value = collapsed;
    }

    function toggleLeftSidebarCollapsed() {
      leftSidebarCollapsed.value = !leftSidebarCollapsed.value;
    }

    /**
     * Book upload modal visibility
     */
    const bookUploadModalVisible = ref(false);
    function setBookUploadModalVisible(visible: boolean) {
      bookUploadModalVisible.value = visible;
    }

    function $reset() {
      // Insert reset logic here if needed
      libraryView.value = 'books';
      leftSidebarWidthPx.value = 260;
      leftSidebarCollapsed.value = false;
      bookUploadModalVisible.value = false;
    }

    return {
      commandPaletteVisible,
      setCommandPaletteVisible,

      libraryView,
      setLibraryView,

      leftSidebarWidthPx,
      setLeftSidebarWidthPx,

      leftSidebarCollapsed,
      setLeftSidebarCollapsed,
      toggleLeftSidebarCollapsed,

      bookUploadModalVisible,
      setBookUploadModalVisible,

      $reset,
    };
  },
  {
    persist: true,
  },
);
