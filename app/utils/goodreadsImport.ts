import type { UserBookStatusValue } from '../../shared/reading-status';

export type GoodreadsCandidate = {
  bookId: string;
  title: string;
  authors: string[];
  collectionName: string;
  hasFiles: boolean;
  score: number;
};

export type GoodreadsMatchKind =
  'goodreads' | 'isbn' | 'title' | 'review' | 'none';

export type GoodreadsRow = {
  index: number;
  goodreadsId: string;
  title: string;
  fullTitle: string;
  seriesName?: string;
  seriesIndex?: number;
  authors: string[];
  isbn10?: string;
  isbn13?: string;
  rating: number;
  publisher?: string;
  pages?: number;
  published?: string;
  dateRead?: string;
  dateAdded?: string;
  exclusiveShelf: string;
  shelves: string[];
  tbrPosition?: number;
  review?: string;
  spoiler?: boolean;
  privateNotes?: string;
  readCount?: number;
  ownedCopies?: number;
  match: {
    kind: GoodreadsMatchKind;
    bookId?: string;
    candidates: GoodreadsCandidate[];
  };
};

export type ExistingReading = {
  status: UserBookStatusValue | null;
  endedDate: string | null;
  rating: number | null;
  review: string;
  hasReview: boolean;
  tbrRank: number | null;
};

export type ShelfCount = { name: string; count: number; existing?: boolean };

export type GoodreadsPreview = {
  rows: GoodreadsRow[];
  existing: Record<string, ExistingReading>;
  exclusiveShelves: ShelfCount[];
  shelves: ShelfCount[];
};

export type ImportInclude = {
  statuses: boolean;
  ratings: boolean;
  reviews: boolean;
  notes: boolean;
  shelves: boolean;
};

export type StatusMap = Record<string, UserBookStatusValue | null>;

/** Pick the Delb status that a Goodreads exclusive shelf most likely means. */
export function defaultStatusFor(shelf: string): UserBookStatusValue | null {
  const name = shelf.toLowerCase();
  if (name === 'read') return 'finished';
  if (name === 'currently-reading') return 'reading';
  if (name === 'to-read') return 'to_be_read';
  if (/\bdnf\b|did-?not-?finish|abandon|gave-?up|unfinished/.test(name)) {
    return 'dnf';
  }
  return null;
}

export function defaultStatusMap(shelves: ShelfCount[]): StatusMap {
  const map: StatusMap = {};
  for (const shelf of shelves) map[shelf.name] = defaultStatusFor(shelf.name);
  return map;
}

/** Goodreads 1–5 stars become Delb's 1–10 half-star scale. */
export function delbRating(stars: number): number | null {
  return stars >= 1 && stars <= 5 ? stars * 2 : null;
}

export type Conflict = {
  status: boolean;
  rating: boolean;
  review: boolean;
};

/**
 * Report which imported values differ from the reader's existing Delb values.
 * This mirrors the server's rules, so a conflict here is a value the import
 * keeps or replaces according to the reader's choice.
 */
export function findConflict(
  row: GoodreadsRow,
  existing: ExistingReading | undefined,
  statusMap: StatusMap,
  include: ImportInclude,
): Conflict {
  const none = { status: false, rating: false, review: false };
  if (!existing) return none;
  const conflict = { ...none };

  const status = statusMap[row.exclusiveShelf] ?? null;
  if (include.statuses && status && existing.status) {
    if (existing.status !== status) {
      conflict.status = true;
    } else if (status === 'finished' || status === 'dnf') {
      conflict.status = (existing.endedDate ?? '') !== (row.dateRead ?? '');
    }
  }

  const rating = delbRating(row.rating);
  if (include.ratings && rating !== null && existing.rating !== null) {
    conflict.rating = existing.rating !== rating;
  }

  const review = (row.review ?? '').trim();
  if (include.reviews && review && existing.hasReview) {
    conflict.review = existing.review.trim() !== review;
  }
  return conflict;
}

export function hasConflict(c: Conflict) {
  return c.status || c.rating || c.review;
}

/** The Delb book a row is matched to, or null when it is not in Delb. */
export function defaultChoice(row: GoodreadsRow): string | null {
  return row.match.kind === 'none' ? null : (row.match.bookId ?? null);
}

export type ApplyItem = {
  index: number;
  bookId: string;
  goodreadsId: string;
  exclusiveShelf: string;
  dateRead: string;
  dateAdded: string;
  tbrPosition: number | null;
  rating: number;
  review: string;
  spoiler: boolean;
  privateNotes: string;
  shelves: string[];
  overwrite: boolean;
};

export function buildApplyItem(
  row: GoodreadsRow,
  bookId: string,
  overwrite: boolean,
): ApplyItem {
  return {
    index: row.index,
    bookId,
    goodreadsId: row.goodreadsId,
    exclusiveShelf: row.exclusiveShelf,
    dateRead: row.dateRead ?? '',
    dateAdded: row.dateAdded ?? '',
    tbrPosition: row.tbrPosition ?? null,
    rating: row.rating,
    review: row.review ?? '',
    spoiler: Boolean(row.spoiler),
    privateNotes: row.privateNotes ?? '',
    shelves: row.shelves,
    overwrite,
  };
}

/** Split a list into batches of at most size items. */
export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export function starsText(rating: number | null): string {
  if (!rating) return '';
  const full = Math.floor(rating / 2);
  const half = rating % 2 === 1;
  return '★'.repeat(full) + (half ? '½' : '');
}
