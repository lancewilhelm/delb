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

/** How a row lines up: centered, or against the right end. */
export type ShelfAlign = 'center' | 'end';

/**
 * Stands books left to right in a row `rowWidth` units wide, in the given
 * order. A row that fits lines up by `align`. A row longer than the shelf
 * runs past its edges so the cut spines show that it continues: centered
 * rows run past both ends; `end` rows start at the left end and run past
 * the right one. Only spines that show at least in part are returned.
 */
export function fillShelf<T extends SpineBook>(
  books: T[],
  rowWidth: number,
  align: ShelfAlign = 'center',
): { spines: PlacedSpine<T>[]; overflows: boolean } {
  const placed: PlacedSpine<T>[] = [];
  let x = 0;
  for (const book of books) {
    const size = spineSize(book);
    placed.push({
      book,
      x,
      width: size.width,
      height: Math.min(size.height, DASHBOARD_SPINE_MAX_HEIGHT),
    });
    x += size.width + SPINE_GAP;
  }
  const total = Math.max(0, x - SPINE_GAP);
  const room = rowWidth - 2 * DASHBOARD_SHELF_INSET;
  const overflows = total > room;
  let shift: number;
  if (align === 'center') shift = (rowWidth - total) / 2;
  else if (overflows) shift = 0;
  else shift = rowWidth - DASHBOARD_SHELF_INSET - total;
  const spines = placed
    .map((spine) => ({ ...spine, x: spine.x + shift }))
    .filter((spine) => spine.x < rowWidth && spine.x + spine.width > 0);
  return { spines, overflows };
}
