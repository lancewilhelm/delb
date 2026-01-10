import { defineStore } from 'pinia';

export type LibraryView = 'books' | 'authors' | 'series' | 'publishers';

export type BooksSortKey = 'dateAdded' | 'alphabetical' | 'publishedDate';
export type SortDirection = 'asc' | 'desc';

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
     * Global search modal visibility
     */
    const globalSearchVisible = ref(false);
    function setGlobalSearchVisible(visible: boolean) {
      globalSearchVisible.value = visible;
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
     * Books "Sort" UI state.
     * Default must be "dateAdded" (date added to library).
     */
    const booksSortKey = ref<BooksSortKey>('dateAdded');
    const booksSortDirection = ref<SortDirection>('desc');

    function setBooksSortKey(key: BooksSortKey) {
      booksSortKey.value = key;

      // Sensible defaults per sort mode:
      // - dateAdded => newest first
      // - publishedDate => newest first
      // - alphabetical => A-Z
      if (key === 'alphabetical') {
        booksSortDirection.value = 'asc';
      } else if (key === 'publishedDate') {
        booksSortDirection.value = 'desc';
      } else if (key === 'dateAdded') {
        booksSortDirection.value = 'desc';
      }
    }

    function setBooksSortDirection(dir: SortDirection) {
      booksSortDirection.value = dir;
    }

    function toggleBooksSortDirection() {
      booksSortDirection.value =
        booksSortDirection.value === 'asc' ? 'desc' : 'asc';
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
      booksSortKey.value = 'dateAdded';
      booksSortDirection.value = 'desc';
      leftSidebarWidthPx.value = 260;
      leftSidebarCollapsed.value = false;
      bookUploadModalVisible.value = false;
      globalSearchVisible.value = false;
    }

    return {
      commandPaletteVisible,
      setCommandPaletteVisible,

      globalSearchVisible,
      setGlobalSearchVisible,

      libraryView,
      setLibraryView,

      booksSortKey,
      setBooksSortKey,
      booksSortDirection,
      setBooksSortDirection,
      toggleBooksSortDirection,

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
