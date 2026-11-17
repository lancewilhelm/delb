import {
  itemHeight,
  itemWidth,
  parseBookshelf,
  SHELF_FLOOR,
  SHELF_CASE_GAP,
  type Bookshelf,
  type Shelf,
  type ShelfItem,
} from './bookshelf';

export type WallRect = {
  left: number;
  right: number;
  bottom: number;
  top: number;
};
type Row = { shelf: Shelf; left: number; right: number; floor: number };

export function bookshelfRows(layout: Bookshelf): Row[] {
  let left = 0;
  return layout.bookcases.flatMap((bookcase) => {
    const caseLeft = left;
    left += bookcase.width + SHELF_CASE_GAP;
    let top = bookcase.shelves.reduce((sum, shelf) => sum + shelf.height, 0);
    return bookcase.shelves.map((shelf) => {
      top -= shelf.height;
      return {
        shelf,
        left: caseLeft,
        right: caseLeft + bookcase.width,
        floor: top,
      };
    });
  });
}

export function booksInRectangle(
  layout: Bookshelf,
  rectangle: WallRect,
): Set<string> {
  const selected = new Set<string>();
  for (const row of bookshelfRows(layout))
    for (const item of row.shelf.items) {
      let bottom = row.floor + SHELF_FLOOR;
      for (const book of item.books) {
        const left =
          row.left + item.x + (item.horizontal ? (book.offsetX ?? 0) : 0);
        const width = item.horizontal ? book.height : book.width;
        const height = item.horizontal ? book.width : book.height;
        if (
          left < rectangle.right &&
          left + width > rectangle.left &&
          bottom < rectangle.top &&
          bottom + height > rectangle.bottom
        )
          selected.add(book.id);
        if (item.horizontal) bottom += height;
      }
    }
  return selected;
}

/** Translate all selected books together, or reject the entire move. */
export function moveSelectedBooks(
  layout: Bookshelf,
  ids: ReadonlySet<string>,
  sourceShelfId: string,
  targetShelfId: string,
  dx: number,
): Bookshelf | null {
  if (!ids.size || !Number.isFinite(dx)) return null;
  const result = structuredClone(layout);
  const rows = bookshelfRows(result);
  const origin = rows.find((row) => row.shelf.id === sourceShelfId);
  const target = rows.find((row) => row.shelf.id === targetShelfId);
  if (!origin || !target) return null;
  const dy = target.floor - origin.floor;
  const moved: { item: ShelfItem; x: number; floor: number }[] = [];
  for (const row of rows) {
    const remaining: ShelfItem[] = [];
    for (const item of row.shelf.items) {
      const chosen = item.books.filter((book) => ids.has(book.id));
      if (!chosen.length) {
        remaining.push(item);
        continue;
      }
      const left = item.horizontal
        ? Math.min(...chosen.map((book) => book.offsetX ?? 0))
        : 0;
      moved.push({
        x: row.left + item.x + left + Math.round(dx),
        floor: row.floor + dy,
        item: {
          ...item,
          books: chosen.map((book) => ({
            ...book,
            offsetX: item.horizontal ? (book.offsetX ?? 0) - left : 0,
          })),
        },
      });
      const rest = item.books.filter((book) => !ids.has(book.id));
      if (rest.length) remaining.push({ ...item, books: rest });
    }
    row.shelf.items = remaining;
  }
  if (
    moved.reduce((count, entry) => count + entry.item.books.length, 0) !==
    ids.size
  )
    return null;
  for (const entry of moved) {
    const row = rows.find(
      (candidate) =>
        candidate.floor === entry.floor &&
        entry.x >= candidate.left + 2 &&
        entry.x + itemWidth(entry.item) <= candidate.right - 2 &&
        itemHeight(entry.item) <= candidate.shelf.height - SHELF_FLOOR,
    );
    if (!row) return null;
    row.shelf.items.push({ ...entry.item, x: entry.x - row.left });
  }
  return parseBookshelf(result);
}
