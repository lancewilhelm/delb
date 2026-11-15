import type { ShelfBook, ShelfItem } from '~~/shared/bookshelf';

export function placementStyle(
  book: ShelfBook,
  item: ShelfItem,
  index: number,
) {
  const bottom = item.horizontal
    ? item.books.slice(0, index).reduce((sum, entry) => sum + entry.width, 0)
    : 0;
  return {
    width: `${item.horizontal ? book.height : book.width}px`,
    height: `${item.horizontal ? book.width : book.height}px`,
    bottom: `${bottom}px`,
  };
}
