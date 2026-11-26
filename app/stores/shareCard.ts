import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useUserSettingsStore } from '~/stores/userSettings';

export type FinishedToast = {
  id: number;
  bookId: string;
  title: string;
};

const TOAST_MS = 9000;

/**
 * Opens the share card dialog from anywhere in the app and shows the
 * "Finished" toast after a reader marks one book as finished.
 */
export const useShareCardStore = defineStore('shareCard', () => {
  const openBookId = ref<string | null>(null);
  const toast = ref<FinishedToast | null>(null);
  let nextId = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function open(bookId: string) {
    dismissToast();
    openBookId.value = bookId;
  }

  function close() {
    openBookId.value = null;
  }

  function dismissToast() {
    clearTimer();
    toast.value = null;
  }

  /** Offers a share card unless the reader turned the offer off. */
  function notifyFinished(book: { id: string; title: string }) {
    const settings = useUserSettingsStore();
    if (settings.activeSettings.shareCard?.promptOnFinish === false) return;
    clearTimer();
    toast.value = { id: nextId++, bookId: book.id, title: book.title };
    timer = setTimeout(() => {
      toast.value = null;
      timer = null;
    }, TOAST_MS);
  }

  /** Keeps the toast up while the pointer or focus is on it. */
  function holdToast() {
    clearTimer();
  }

  function releaseToast() {
    if (!toast.value) return;
    clearTimer();
    timer = setTimeout(() => {
      toast.value = null;
      timer = null;
    }, TOAST_MS / 2);
  }

  function stopAsking() {
    const settings = useUserSettingsStore();
    void settings.updateSettings(
      { shareCard: { promptOnFinish: false } },
      { immediate: true },
    );
    dismissToast();
  }

  return {
    openBookId,
    toast,
    open,
    close,
    notifyFinished,
    dismissToast,
    holdToast,
    releaseToast,
    stopAsking,
  };
});
