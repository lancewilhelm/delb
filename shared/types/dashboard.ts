export type DashboardShelf = 'reading' | 'recent';

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
  updatedAt: string;
  progress: number | null;
  finishedDate: string | null;
};

export type DashboardData = {
  counts: DashboardCounts;
  shelf: {
    kind: DashboardShelf;
    books: DashboardBook[];
    nextOffset: number | null;
  };
};
