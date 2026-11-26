import { estimatedWidth, stableHeight } from '~~/shared/bookshelf';

/**
 * Shelf card art stands spines in one row, sized the way the bookshelf sizes
 * them (in its units, CSS pixels at 100%), then scales the row to fit.
 */
/** Tallest spine drawn; taller stored sizes are cut down to this. */
export const DASHBOARD_SPINE_MAX_HEIGHT = 231;
/** Space at each end of the row. */
export const DASHBOARD_SHELF_INSET = 6;
const SPINE_GAP = 1;

/** What Shelf art needs to know about a book. */
export type SpineBook = {
  id: string;
  title: string;
  spineRevision?: string | null;
  pages?: number | null;
  /** Stored bookshelf size; null until the book has one. */
  shelfWidth?: number | null;
  shelfHeight?: number | null;
};

export type PlacedSpine<T> = {
  book: T;
  x: number;
  width: number;
  height: number;
};

/** A spine's size on the bookshelf: its stored size, else an estimate. */
export function spineSize(book: SpineBook): { width: number; height: number } {
  return {
    width: book.shelfWidth ?? estimatedWidth(book.pages),
    height: book.shelfHeight ?? stableHeight(book.id),
  };
}

/**
 * Stands books left to right in a row `rowWidth` units wide, in the given
 * order, until the next book does not fit. The row is centered, so a short
 * row sits in the middle.
 */
export function fillShelf<T extends SpineBook>(
  books: T[],
  rowWidth: number,
): PlacedSpine<T>[] {
  const row: PlacedSpine<T>[] = [];
  const end = rowWidth - DASHBOARD_SHELF_INSET;
  let x = DASHBOARD_SHELF_INSET;
  for (const book of books) {
    const size = spineSize(book);
    if (x + size.width > end) break;
    row.push({
      book,
      x,
      width: size.width,
      height: Math.min(size.height, DASHBOARD_SPINE_MAX_HEIGHT),
    });
    x += size.width + SPINE_GAP;
  }
  const used = x - SPINE_GAP - DASHBOARD_SHELF_INSET;
  const shift = row.length
    ? (rowWidth - 2 * DASHBOARD_SHELF_INSET - used) / 2
    : 0;
  for (const spine of row) spine.x += shift;
  return row;
}
