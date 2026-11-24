export type DashboardShelf = 'reading' | 'finished' | 'tbr';

export type DashboardCounts = {
  total: number;
  none: number;
  to_be_read: number;
  reading: number;
  finished: number;
  dnf: number;
};

export type DashboardBook = {
  id: string;
  title: string;
  coverImagePath: string | null;
  hasPhysicalCopy: boolean;
  hasAudiobookCopy: boolean;
  updatedAt: string;
  progress: number | null;
  finishedDate: string | null;
  /** Set when the book has spine artwork (`/api/books/:id/spine?v=`). */
  spineRevision?: string | null;
};

export type DashboardData = {
  counts: DashboardCounts;
  shelf: {
    kind: DashboardShelf;
    books: DashboardBook[];
    nextOffset: number | null;
  };
};

/** Status lists previewed on the dashboard overview. */
export type DashboardListKey =
  'reading' | 'to_be_read' | 'finished' | 'dnf' | 'none';

/** `GET /api/dashboard/overview` response data. */
export type DashboardOverview = {
  counts: DashboardCounts;
  /** Most recently added visible books, newest first (cover wall). */
  recent: DashboardBook[];
  /** Up to 25 books per status list, in that list's order. */
  lists: Record<DashboardListKey, DashboardBook[]>;
};
