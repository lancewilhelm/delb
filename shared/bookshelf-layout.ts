import {
  emptyBookshelf,
  itemHeight,
  itemWidth,
  parseBookshelf,
  SHELF_FLOOR,
  SHELF_WIDTH,
  type Bookshelf,
  type ShelfBook,
  type ShelfItem,
} from './bookshelf';

/** Private anchors remain stored even when their books are not visible. */
export type BookPlacementAnchor = {
  caseId: string;
  shelfId: string;
  stackId: string;
  x: number;
  bookX?: number;
  horizontal: boolean;
  order: number;
  width?: number;
  height?: number;
  dormant?: boolean;
};

export type BookLayoutEntry = {
  book: ShelfBook;
  placement: BookPlacementAnchor | null;
};

export function emptyBookshelfGeometry(): Bookshelf {
  return emptyBookshelf();
}

/** Geometry never stores member IDs. Membership and placement live together. */
export function bookshelfGeometry(layout: Bookshelf): Bookshelf {
  return {
    version: layout.version,
    pictures: structuredClone(layout.pictures ?? []),
    bookcases: layout.bookcases.map((bookcase) => ({
      ...bookcase,
      shelves: bookcase.shelves.map((shelf) => ({ ...shelf, items: [] })),
    })),
  };
}

/** Compose only visible members; hidden anchors are never supplied to this function. */
export function composeBookshelfLayout(
  rawGeometry: unknown,
  members: BookLayoutEntry[],
  shelfId: string,
): { arrangement: Bookshelf; adjustments: string[] } {
  const geometry = parseBookshelf(rawGeometry);
  if (
    !geometry ||
    geometry.bookcases.some((c) => c.shelves.some((s) => s.items.length))
  )
    throw new Error('Invalid bookshelf geometry');
  const result = bookshelfGeometry(geometry);
  const adjustments: string[] = [];
  const groups = new Map<string, BookLayoutEntry[]>();
  const pending: BookLayoutEntry[] = [];
  for (const member of members) {
    const placement = member.placement;
    if (!placement) {
      pending.push(member);
      continue;
    }
    const key = JSON.stringify([
      placement.caseId,
      placement.shelfId,
      placement.stackId,
    ]);
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  const rows = result.bookcases.flatMap((bookcase) =>
    bookcase.shelves.map((row) => ({ bookcase, row })),
  );
  const rowIndexes = new Map(
    rows.map(({ bookcase, row }, index) => [
      JSON.stringify([bookcase.id, row.id]),
      index,
    ]),
  );
  const isDisplaced = (member: BookLayoutEntry) => {
    const placement = member.placement!;
    return !!(
      placement.dormant ||
      (placement.width !== undefined &&
        placement.width !== member.book.width) ||
      (placement.height !== undefined &&
        placement.height !== member.book.height)
    );
  };
  const ordered = [...groups.values()].sort((a, b) => {
    const x = a[0]!.placement!;
    const y = b[0]!.placement!;
    const rowIndex = (p: BookPlacementAnchor) =>
      rowIndexes.get(JSON.stringify([p.caseId, p.shelfId])) ?? -1;
    const priority = (group: BookLayoutEntry[]) =>
      group.some(isDisplaced) ? 1 : 0;
    return (
      priority(a) - priority(b) ||
      rowIndex(x) - rowIndex(y) ||
      Math.min(
        ...a.map((member) => member.placement!.bookX ?? member.placement!.x),
      ) -
        Math.min(
          ...b.map((member) => member.placement!.bookX ?? member.placement!.x),
        ) ||
      x.stackId.localeCompare(y.stackId)
    );
  });
  for (const group of ordered) {
    group.sort(
      (a, b) =>
        a.placement!.order - b.placement!.order ||
        a.book.id.localeCompare(b.book.id),
    );
    const p = group[0]!.placement!;
    const entry =
      rows[rowIndexes.get(JSON.stringify([p.caseId, p.shelfId])) ?? -1];
    const bookcase = entry?.bookcase;
    const row = entry?.row;
    if (
      !row ||
      !bookcase ||
      group.some((m) => m.placement!.horizontal !== p.horizontal) ||
      (!p.horizontal && group.length > 1)
    ) {
      pending.push(...group);
      continue;
    }
    const left = Math.min(
      ...group.map((m) => m.placement!.bookX ?? m.placement!.x),
    );
    const item: ShelfItem = {
      x: left,
      horizontal: p.horizontal,
      books: group.map((m) => ({
        ...m.book,
        offsetX: p.horizontal
          ? (m.placement!.bookX ?? m.placement!.x) - left
          : 0,
      })),
    };
    const fits = (candidate: ShelfItem) =>
      Number.isInteger(candidate.x) &&
      candidate.x >= 2 &&
      candidate.x + itemWidth(candidate) <= bookcase.width - 2 &&
      itemHeight(candidate) <= row.height - SHELF_FLOOR &&
      !row.items.some(
        (other) =>
          candidate.x < other.x + itemWidth(other) &&
          other.x < candidate.x + itemWidth(candidate),
      );
    if (!fits(item)) {
      const unchanged = group.filter((member) => !isDisplaced(member));
      const changed = group.filter(isDisplaced);
      const remaining = {
        ...item,
        books: item.books.filter((book) =>
          unchanged.some((member) => member.book.id === book.id),
        ),
      };
      if (unchanged.length && changed.length && fits(remaining)) {
        row.items.push(remaining);
        pending.push(...changed);
      } else pending.push(...group);
    } else {
      row.items.push(item);
    }
  }
  const knownIds = new Set(
    result.bookcases.flatMap((c) => [c.id, ...c.shelves.map((s) => s.id)]),
  );
  let generated = 0;
  const nextId = (kind: string) => {
    let id: string;
    do id = `personal-${shelfId}-${kind}-${generated++}`;
    while (knownIds.has(id));
    knownIds.add(id);
    return id;
  };
  let appendIndex = Math.max(
    0,
    rows.findLastIndex(({ row }) => row.items.length > 0),
  );
  for (const member of pending) {
    const item: ShelfItem = {
      x: 2,
      horizontal: false,
      books: [{ ...member.book, offsetX: 0 }],
    };
    let placed = false;
    while (appendIndex < rows.length) {
      const { bookcase, row } = rows[appendIndex]!;
      const x = Math.max(
        2,
        ...row.items.map((existing) => existing.x + itemWidth(existing)),
      );
      if (
        x + itemWidth(item) <= bookcase.width - 2 &&
        itemHeight(item) <= row.height - SHELF_FLOOR
      ) {
        item.x = x;
        row.items.push(item);
        placed = true;
        break;
      }
      appendIndex++;
    }
    if (!placed) {
      const bookcase = {
        id: nextId('case'),
        width: SHELF_WIDTH,
        shelves: Array.from({ length: 3 }, () => ({
          id: nextId('row'),
          height: 245,
          items: [] as ShelfItem[],
        })),
      };
      bookcase.shelves[0]!.items.push(item);
      result.bookcases.push(bookcase);
      rows.push(...bookcase.shelves.map((row) => ({ bookcase, row })));
    }
    if (member.placement) adjustments.push(member.book.id);
  }
  if (!parseBookshelf(result))
    throw new Error('The bookshelf cannot fit its books');
  return { arrangement: result, adjustments };
}
