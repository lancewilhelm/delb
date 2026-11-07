import type { UserBookStatusValue } from './db/schema';

export type BookStatusChange = {
  bookId: string;
  status: UserBookStatusValue | null;
};

const statusDetails = {
  to_be_read: { label: 'To be read', icon: 'lucide:bookmark' },
  reading: { label: 'Reading', icon: 'lucide:book-open' },
  finished: { label: 'Finished', icon: 'lucide:party-popper' },
  dnf: { label: 'DNF', icon: 'lucide:skull' },
} satisfies Record<UserBookStatusValue, { label: string; icon: string }>;

export function readingStatusDetails(status: string | null | undefined) {
  switch (status) {
    case 'to_be_read':
    case 'reading':
    case 'finished':
    case 'dnf':
      return statusDetails[status];
    default:
      return null;
  }
}

/** Update the loaded record without replacing the dataset or its pagination. */
export function applyBookStatusChange({
  books,
  change,
  endpoint,
}: {
  books: { id: string; status?: string | null }[];
  change: BookStatusChange;
  endpoint: string;
}) {
  const index = books.findIndex((book) => book.id === change.bookId);
  const book = books[index];
  if (!book) return;
  book.status = change.status;

  const filter = new URL(endpoint, 'http://localhost').searchParams.get(
    'status',
  );
  const allowed = filter
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowed?.length && !allowed.includes(change.status ?? 'none')) {
    books.splice(index, 1);
  }
}
