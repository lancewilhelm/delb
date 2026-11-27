import { defineStore } from 'pinia';
import { ref } from 'vue';

export type SavedMiniCoverSpine = {
  bookId: string;
  revision: string;
  savedAt: number;
};

/**
 * Opens the Mini Book Cover studio modal from any page and broadcasts
 * when an editor saves an updated spine back to the book.
 */
export const useMiniCoverStore = defineStore('miniCover', () => {
  const openBookId = ref<string | null>(null);
  const lastSavedSpine = ref<SavedMiniCoverSpine | null>(null);

  function open(bookId: string) {
    openBookId.value = bookId;
  }

  function close() {
    openBookId.value = null;
  }

  function notifySpineSaved(bookId: string, revision: string) {
    lastSavedSpine.value = { bookId, revision, savedAt: Date.now() };
  }

  return {
    openBookId,
    lastSavedSpine,
    open,
    close,
    notifySpineSaved,
  };
});
