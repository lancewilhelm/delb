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
  /** A spine width set by hand on the bookshelf; null when the width follows the page count. */
  shelfWidth?: number | null;
  /** The stored spine height; null when the book has none. */
  shelfHeight?: number | null;
};

export type PlacedSpine<T> = {
  book: T;
  x: number;
  width: number;
  height: number;
};

/**
 * A spine's size on the bookshelf: a width set by hand, else one from the
 * current page count, and the stored height, else the bookshelf's estimate.
 */
export function spineSize(book: SpineBook): { width: number; height: number } {
  return {
    width: book.shelfWidth ?? estimatedWidth(book.pages),
    height: book.shelfHeight ?? stableHeight(book.id),
  };
}

/** How a row lines up: centered, or running off the right end. */
export type ShelfAlign = 'center' | 'end';

/**
 * Stands books left to right in a row `rowWidth` units wide, in the given
 * order, and returns the spines that show at least in part.
 *
 * `center`: a row that fits is centered; a longer row is centered too, so it
 * runs past both ends and the cut spines show that it continues.
 *
 * `end`: the right end always cuts a spine at its middle, so the row looks
 * like it carries on. When every book fits, that is the last book; otherwise
 * it is the book that reaches the right end, and the row starts at the left.
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
  let shift = (rowWidth - total) / 2;
  if (align === 'end' && placed.length) {
    const cut = overflows
      ? (placed.findLast((spine) => spine.x < rowWidth) ?? placed[0]!)
      : placed.at(-1)!;
    shift = rowWidth - (cut.x + cut.width / 2);
  }
  const spines = placed
    .map((spine) => ({ ...spine, x: spine.x + shift }))
    .filter((spine) => spine.x < rowWidth && spine.x + spine.width > 0);
  return { spines, overflows };
}
