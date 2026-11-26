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
  /**
   * Page count and bookshelf size, for sizing Shelf art spines. `shelfWidth`
   * is set only for a width set by hand; otherwise the width follows `pages`.
   */
  pages?: number | null;
  shelfWidth?: number | null;
  shelfHeight?: number | null;
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
  /**
   * Random samples for Pile art: up to 24 books from the whole scope (`all`)
   * and up to 10 per status list. Overviews cached before piles existed lack it.
   */
  piles?: Record<DashboardPileKey, DashboardBook[]>;
};

/** Piles the overview samples: the All books card and each status list. */
export type DashboardPileKey = 'all' | DashboardListKey;
