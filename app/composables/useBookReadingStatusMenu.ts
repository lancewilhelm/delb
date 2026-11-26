import { useShareCardStore } from '~/stores/shareCard';
import { $fetch } from '~/utils/apiFetch';
import type { BookStatusChange } from '~/utils/bookReadingStatus';
import type { CoverMenuItem } from '~/utils/coverMenu';
import type { UserBookStatusValue } from '~~/shared/reading-status';

const statusOptions = [
  { value: 'to_be_read', label: 'To be read' },
  { value: 'reading', label: 'Reading' },
  { value: 'finished', label: 'Finished' },
  { value: 'dnf', label: 'DNF' },
  { value: null, label: 'No status' },
] satisfies { value: UserBookStatusValue | null; label: string }[];

type StatusResponse =
  | { success: true; data: { status: UserBookStatusValue | null } }
  | { success: false; message: string };

export function useBookReadingStatusMenu({
  bookId,
  bookTitle,
  onChanged,
}: {
  bookId: () => string;
  /** Used by the "Finished" toast that offers a share card. */
  bookTitle?: () => string;
  onChanged: (change: BookStatusChange) => void;
}) {
  const shareCard = useShareCardStore();

  async function getReadingStatusMenuItem(): Promise<CoverMenuItem> {
    // Resolve on every open so a change from another view/device is reflected.
    const id = bookId();
    const endpoint = `/api/books/${encodeURIComponent(id)}/status`;
    try {
      const response = await $fetch<StatusResponse>(endpoint);
      if (!response.success) throw new Error(response.message);

      return {
        key: 'reading-status',
        label: 'Reading status',
        children: statusOptions.map(({ value, label }) => ({
          key: `status:${value ?? 'none'}`,
          label,
          checked: response.data.status === value,
          onSelect: async () => {
            try {
              const saved = await $fetch<StatusResponse>(endpoint, {
                method: 'POST',
                body: { status: value },
              });
              if (!saved.success) throw new Error(saved.message);
              onChanged({ bookId: id, status: saved.data.status });
              if (
                saved.data.status === 'finished' &&
                response.data.status !== 'finished'
              ) {
                shareCard.notifyFinished({
                  id,
                  title: bookTitle?.() || 'this book',
                });
              }
            } catch {
              throw new Error(
                'Failed to save reading status. Please try again.',
              );
            }
          },
        })),
      };
    } catch {
      return {
        key: 'reading-status',
        label: 'Reading status unavailable',
        disabled: true,
        children: [],
      };
    }
  }

  return { getReadingStatusMenuItem };
}
