import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * Opens the Mini Book Cover studio modal from any page.
 */
export const useMiniCoverStore = defineStore('miniCover', () => {
  const openBookId = ref<string | null>(null);

  function open(bookId: string) {
    openBookId.value = bookId;
  }

  function close() {
    openBookId.value = null;
  }

  return {
    openBookId,
    open,
    close,
  };
});
