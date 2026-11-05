import type { CoverMenuItem } from '~/utils/coverMenu';
import type { UserBookStatusValue } from '~/utils/db/schema';

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
  onChanged,
}: {
  bookId: () => string;
  onChanged: () => void;
}) {
  async function getReadingStatusMenuItem(): Promise<CoverMenuItem> {
    // Resolve on every open so a change from another view/device is reflected.
    const endpoint = `/api/books/${encodeURIComponent(bookId())}/status`;
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
            } catch {
              throw new Error(
                'Failed to save reading status. Please try again.',
              );
            }
            onChanged();
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
