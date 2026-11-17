export const SHELF_WIDTH = 340;
export const SHELF_CASE_GAP = 10;
export const SHELF_MIN_WIDTH = 120;
export const SHELF_MAX_WIDTH = 700;
export const SHELF_FLOOR = 14;
export const SHELF_MIN_HEIGHT = 120;
export const SHELF_MAX_HEIGHT = 500;
export const BOOKSHELF_MAX_BOOKS = 20000;

export type ShelfBook = {
  id: string;
  offsetX?: number;
  width: number;
  height: number;
  manualWidth: boolean;
  manualHeight: boolean;
  sourcePages: number | null;
};
export type ShelfItem = { x: number; horizontal: boolean; books: ShelfBook[] };
export type Shelf = { id: string; height: number; items: ShelfItem[] };
export type Bookcase = { id: string; width: number; shelves: Shelf[] };
export type ShelfPicture = {
  id: string;
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};
export type Bookshelf = {
  bookcases: Bookcase[];
  version?: 2;
  pictures?: ShelfPicture[];
};
export type ShelfCatalogBook = {
  id: string;
  pages?: number | null;
  dimensions?: Pick<
    ShelfBook,
    'width' | 'height' | 'manualWidth' | 'manualHeight' | 'sourcePages'
  > | null;
};

export function itemWidth(item: ShelfItem): number {
  return Math.max(
    ...item.books.map((book) =>
      item.horizontal ? (book.offsetX ?? 0) + book.height : book.width,
    ),
  );
}
export function itemHeight(item: ShelfItem): number {
  return item.horizontal
    ? item.books.reduce((sum, book) => sum + book.width, 0)
    : item.books[0]!.height;
}
export function minimumShelfHeight(shelf: Shelf): number {
  return Math.max(
    SHELF_MIN_HEIGHT,
    ...shelf.items.map((item) => itemHeight(item) + SHELF_FLOOR),
  );
}
export function minimumBookcaseWidth(bookcase: Bookcase): number {
  return Math.max(
    SHELF_MIN_WIDTH,
    ...bookcase.shelves.flatMap((shelf) =>
      shelf.items.map((item) => item.x + itemWidth(item) + 2),
    ),
  );
}

/** Shift one horizontal book without moving the other books on its shelf. */
export function shiftStackBook(
  shelf: Shelf,
  shelfWidth: number,
  bookId: string,
  delta: number,
): ShelfItem[] | null {
  if (!Number.isInteger(delta)) return null;
  const items = structuredClone(shelf.items);
  const item = items.find((entry) =>
    entry.books.some((book) => book.id === bookId),
  );
  if (!item?.horizontal || item.books.length < 2) return null;
  const book = item.books.find((entry) => entry.id === bookId)!;
  book.offsetX = (book.offsetX ?? 0) + delta;
  const left = Math.min(...item.books.map((entry) => entry.offsetX ?? 0));
  item.x += left;
  for (const entry of item.books) entry.offsetX = (entry.offsetX ?? 0) - left;
  items.sort((a, b) => a.x - b.x);
  if (
    item.x < 2 ||
    items.some(
      (entry, i) =>
        entry.x + itemWidth(entry) > shelfWidth - 2 ||
        (i > 0 && items[i - 1]!.x + itemWidth(items[i - 1]!) > entry.x),
    )
  )
    return null;
  return items;
}
function normalizedPages(pages: number | null | undefined): number | null {
  return typeof pages === 'number' &&
    Number.isInteger(pages) &&
    pages >= 0 &&
    pages <= 1000000
    ? pages
    : null;
}
export function estimatedWidth(pages: number | null | undefined): number {
  return pages && pages > 0
    ? Math.max(22, Math.min(55, Math.round(20 + pages / 25)))
    : 32;
}
function stableHeight(id: string): number {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return 180 + (hash % 41);
}
export function emptyShelf(): Shelf {
  return {
    id: crypto.randomUUID(),
    height: 245,
    items: [],
  };
}
export function emptyBookshelf(): Bookshelf {
  return {
    version: 2,
    pictures: [],
    bookcases: [
      {
        id: crypto.randomUUID(),
        width: SHELF_WIDTH,
        shelves: [emptyShelf(), emptyShelf(), emptyShelf()],
      },
    ],
  };
}
export function packShelf(
  items: ShelfItem[],
  moving: ShelfItem,
  requestedX: number,
  shelfHeight: number,
  shelfWidth = SHELF_WIDTH,
): ShelfItem[] | null {
  if (
    itemHeight(moving) > shelfHeight - SHELF_FLOOR ||
    itemWidth(moving) > shelfWidth - 4
  )
    return null;
  const entries = structuredClone(items).sort((a, b) => a.x - b.x);
  const x = Math.max(
    2,
    Math.min(Math.round(requestedX), shelfWidth - itemWidth(moving) - 2),
  );
  let index = entries.findIndex((item) => item.x + itemWidth(item) / 2 > x);
  if (index < 0) index = entries.length;
  const left = index
    ? entries[index - 1]!.x + itemWidth(entries[index - 1]!)
    : 2;
  entries.splice(index, 0, {
    ...structuredClone(moving),
    x: Math.max(x, left),
  });
  for (let i = index + 1; i < entries.length; i++) {
    entries[i]!.x = Math.max(
      entries[i]!.x,
      entries[i - 1]!.x + itemWidth(entries[i - 1]!),
    );
  }
  return entries.some((item) => item.x + itemWidth(item) > shelfWidth - 2)
    ? null
    : entries;
}
export function closestPlacement(
  items: ShelfItem[],
  moving: ShelfItem,
  x: number,
  shelfHeight: number,
  shelfWidth = SHELF_WIDTH,
): ShelfItem[] | null {
  let best: ShelfItem[] | null = null;
  let distance = Infinity;
  for (let point = 2; point <= shelfWidth - itemWidth(moving) - 2; point++) {
    const candidate = packShelf(items, moving, point, shelfHeight, shelfWidth);
    const placed = candidate?.find((item) =>
      item.books.some((book) => book.id === moving.books[0]!.id),
    );
    if (candidate && placed && Math.abs(placed.x - x) < distance) {
      best = candidate;
      distance = Math.abs(placed.x - x);
    }
  }
  return best;
}

export type ShelfDrop = {
  sourceItems: ShelfItem[];
  items: ShelfItem[];
  moving: ShelfItem;
  x: number;
  bottom: number;
  valid: boolean;
};

// Pointer coordinates are in unscaled shelf units, with y measured from the shelf floor.
export function planShelfDrop(
  origin: Shelf,
  destination: Shelf,
  destinationWidth: number,
  bookId: string,
  whole: boolean,
  pointerX: number,
  pointerY: number,
  grabOffset: number,
  grabOffsetY = 0,
): ShelfDrop | null {
  const sourceItems = structuredClone(origin.items);
  const source = sourceItems.find((item) =>
    item.books.some((book) => book.id === bookId),
  );
  const book = source?.books.find((entry) => entry.id === bookId);
  if (!source || !book) return null;
  const sourceIndex = source.books.findIndex((entry) => entry.id === bookId);
  const bookBottom = source.horizontal
    ? source.books
        .slice(0, sourceIndex)
        .reduce((sum, entry) => sum + entry.width, 0)
    : 0;
  const sourceHeight = source.horizontal ? book.width : book.height;
  const grabHeight =
    bookBottom +
    sourceHeight -
    Math.max(0, Math.min(sourceHeight, grabOffsetY));
  const downThreshold = Math.min(32, Math.max(8, grabHeight - 4));
  const moving: ShelfItem = whole
    ? structuredClone(source)
    : {
        x: source.x,
        horizontal: source.horizontal
          ? pointerY <= grabHeight + 32
          : pointerY <= grabHeight - downThreshold,
        books: [{ ...structuredClone(book), offsetX: 0 }],
      };
  if (whole) sourceItems.splice(sourceItems.indexOf(source), 1);
  else {
    source.books = source.books.filter((entry) => entry.id !== bookId);
    if (!source.books.length)
      sourceItems.splice(sourceItems.indexOf(source), 1);
  }
  const others =
    destination.id === origin.id
      ? sourceItems
      : structuredClone(destination.items);
  const wantedX =
    pointerX -
    (whole || moving.horizontal || !source.horizontal
      ? grabOffset
      : Math.min(book.width / 2, grabOffset));
  const target = others.find(
    (item) =>
      item.horizontal &&
      pointerX >= item.x + itemWidth(item) * 0.25 &&
      pointerX <= item.x + itemWidth(item) * 0.75 &&
      pointerY >= 0 &&
      pointerY <= itemHeight(item) + 12,
  );
  let items: ShelfItem[] | null;
  let bottom = SHELF_FLOOR;
  if (target) {
    moving.horizontal = true;
    const combined: ShelfItem = {
      ...target,
      books: [...target.books, ...moving.books],
    };
    items = packShelf(
      others.filter((item) => item !== target),
      combined,
      target.x,
      destination.height,
      destinationWidth,
    );
    bottom += itemHeight(target);
  } else {
    items = closestPlacement(
      others,
      moving,
      wantedX,
      destination.height,
      destinationWidth,
    );
  }
  const placed = items?.find((item) =>
    item.books.some((entry) => entry.id === bookId),
  );
  return {
    sourceItems,
    items: items ?? [],
    moving,
    x:
      placed?.x ??
      Math.max(2, Math.min(wantedX, destinationWidth - itemWidth(moving) - 2)),
    bottom,
    valid: !!items,
  };
}

// Called only after the complete accessible catalog has loaded successfully.
export function reconcileBookshelf(
  value: Bookshelf,
  catalog: ShelfCatalogBook[],
): { bookshelf: Bookshelf; needsAdjustment: string[]; changed: boolean } {
  const bookshelf = structuredClone(value);
  const visible = new Map(catalog.map((book) => [book.id, book]));
  const found = new Set<string>();
  const needsAdjustment: string[] = [];
  let changed = false;
  for (const bookcase of bookshelf.bookcases)
    for (const shelf of bookcase.shelves) {
      for (const item of shelf.items) {
        const previous = item.books.length;
        item.books = item.books.filter((book) => visible.has(book.id));
        if (previous !== item.books.length) changed = true;
        for (const book of item.books) {
          found.add(book.id);
          const pages = normalizedPages(visible.get(book.id)?.pages);
          if (!book.manualWidth && book.sourcePages !== pages) {
            const old = book.width;
            book.width = estimatedWidth(pages);
            const sorted = [...shelf.items]
              .filter((other) => other.books.length)
              .sort((a, b) => a.x - b.x);
            const fits =
              itemHeight(item) <= shelf.height - SHELF_FLOOR &&
              sorted.every(
                (current, i) =>
                  current.x + itemWidth(current) <= bookcase.width - 2 &&
                  (!i ||
                    sorted[i - 1]!.x + itemWidth(sorted[i - 1]!) <= current.x),
              );
            if (fits) {
              book.sourcePages = pages;
              changed = true;
            } else {
              book.width = old;
              needsAdjustment.push(book.id);
            }
          }
        }
      }
      shelf.items = shelf.items.filter((item) => item.books.length);
    }
  const shelves = bookshelf.bookcases.flatMap((bookcase) =>
    bookcase.shelves.map((shelf) => ({ shelf, bookcase })),
  );
  let appendIndex = Math.max(
    0,
    shelves.findLastIndex(({ shelf }) => shelf.items.length > 0),
  );
  for (const catalogBook of catalog) {
    if (found.has(catalogBook.id)) continue;
    const newBook: ShelfBook = catalogBook.dimensions
      ? {
          id: catalogBook.id,
          ...catalogBook.dimensions,
        }
      : {
          id: catalogBook.id,
          width: estimatedWidth(normalizedPages(catalogBook.pages)),
          height: stableHeight(catalogBook.id),
          manualWidth: false,
          manualHeight: false,
          sourcePages: normalizedPages(catalogBook.pages),
        };
    const pages = normalizedPages(catalogBook.pages);
    if (!newBook.manualWidth && newBook.sourcePages !== pages) {
      newBook.width = estimatedWidth(pages);
      newBook.sourcePages = pages;
    }
    const item: ShelfItem = { x: 2, horizontal: false, books: [newBook] };
    let { shelf, bookcase } = shelves[appendIndex]!;
    let lastX = Math.max(
      2,
      ...shelf.items.map((entry) => entry.x + itemWidth(entry)),
    );
    while (
      lastX + itemWidth(item) > bookcase.width - 2 ||
      itemHeight(item) > shelf.height - SHELF_FLOOR
    ) {
      appendIndex++;
      if (!shelves[appendIndex]) {
        const next = {
          id: crypto.randomUUID(),
          width: SHELF_WIDTH,
          shelves: [emptyShelf(), emptyShelf(), emptyShelf()],
        };
        bookshelf.bookcases.push(next);
        shelves.push(
          ...next.shelves.map((shelf) => ({ shelf, bookcase: next })),
        );
      }
      ({ shelf, bookcase } = shelves[appendIndex]!);
      lastX = Math.max(
        2,
        ...shelf.items.map((entry) => entry.x + itemWidth(entry)),
      );
    }
    item.x = lastX;
    shelf.items.push(item);
    changed = true;
  }
  return { bookshelf, needsAdjustment, changed };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
// Validate the complete geometry before accepting a client-owned arrangement.
export function parseBookshelf(value: unknown): Bookshelf | null {
  if (
    !record(value) ||
    !Array.isArray(value.bookcases) ||
    value.bookcases.length < 1 ||
    value.bookcases.length > 1000
  )
    return null;
  if (
    !(value.version === undefined || value.version === 2) ||
    !(value.pictures === undefined || Array.isArray(value.pictures))
  )
    return null;
  const pictures: ShelfPicture[] = [];
  const pictureIds = new Set<string>();
  for (const picture of value.pictures ?? []) {
    if (
      !record(picture) ||
      !id(picture.id) ||
      pictureIds.has(picture.id) ||
      !id(picture.assetId) ||
      !integer(picture.x, -100000, 100000) ||
      !integer(picture.y, -100000, 100000) ||
      !integer(picture.width, 10, 4000) ||
      !integer(picture.height, 10, 4000) ||
      !integer(picture.rotation, -180, 180) ||
      pictures.length >= 100
    )
      return null;
    pictureIds.add(picture.id);
    pictures.push({
      id: picture.id,
      assetId: picture.assetId,
      x: picture.x,
      y: picture.y,
      width: picture.width,
      height: picture.height,
      rotation: picture.rotation,
    });
  }
  const result: Bookshelf = { bookcases: [], version: 2, pictures },
    ids = new Set<string>(),
    bookIds = new Set<string>();
  let total = 0;
  for (const rawCase of value.bookcases) {
    if (
      !record(rawCase) ||
      !id(rawCase.id) ||
      ids.has(rawCase.id) ||
      !Array.isArray(rawCase.shelves) ||
      rawCase.shelves.length < 1 ||
      rawCase.shelves.length > 1000
    )
      return null;
    ids.add(rawCase.id);
    const legacyWidths: number[] = [];
    for (const legacy of rawCase.shelves) {
      if (
        !record(legacy) ||
        !(
          legacy.width === undefined ||
          integer(legacy.width, SHELF_MIN_WIDTH, SHELF_MAX_WIDTH)
        )
      )
        return null;
      legacyWidths.push(
        legacy.width === undefined ? SHELF_WIDTH : legacy.width,
      );
    }
    if (!(
      rawCase.width === undefined ||
      integer(rawCase.width, SHELF_MIN_WIDTH, SHELF_MAX_WIDTH)
    ))
      return null;
    const caseWidth =
      rawCase.width === undefined ? Math.max(...legacyWidths) : rawCase.width;
    const bookcase: Bookcase = {
      id: rawCase.id,
      width: caseWidth,
      shelves: [],
    };
    for (const rawShelf of rawCase.shelves) {
      if (
        !record(rawShelf) ||
        !id(rawShelf.id) ||
        ids.has(rawShelf.id) ||
        !integer(rawShelf.height, SHELF_MIN_HEIGHT, SHELF_MAX_HEIGHT) ||
        !Array.isArray(rawShelf.items)
      )
        return null;
      ids.add(rawShelf.id);
      const shelf: Shelf = {
        id: rawShelf.id,
        height: rawShelf.height,
        items: [],
      };
      for (const rawItem of rawShelf.items) {
        if (
          !record(rawItem) ||
          !integer(rawItem.x, 2, bookcase.width - 2) ||
          typeof rawItem.horizontal !== 'boolean' ||
          !Array.isArray(rawItem.books) ||
          !rawItem.books.length ||
          (!rawItem.horizontal && rawItem.books.length !== 1)
        )
          return null;
        const item: ShelfItem = {
          x: rawItem.x,
          horizontal: rawItem.horizontal,
          books: [],
        };
        for (const rawBook of rawItem.books) {
          if (
            !record(rawBook) ||
            !id(rawBook.id) ||
            bookIds.has(rawBook.id) ||
            !integer(rawBook.width, 20, 55) ||
            !integer(rawBook.height, 120, 230) ||
            typeof rawBook.manualWidth !== 'boolean' ||
            typeof rawBook.manualHeight !== 'boolean' ||
            !(
              rawBook.offsetX === undefined ||
              integer(rawBook.offsetX, 0, SHELF_MAX_WIDTH)
            ) ||
            (!rawItem.horizontal && (rawBook.offsetX ?? 0) !== 0) ||
            !(
              rawBook.sourcePages === null ||
              integer(rawBook.sourcePages, 0, 1000000)
            )
          )
            return null;
          bookIds.add(rawBook.id);
          if (++total > BOOKSHELF_MAX_BOOKS) return null;
          item.books.push({
            id: rawBook.id,
            ...(rawBook.offsetX === undefined
              ? {}
              : { offsetX: rawBook.offsetX }),
            width: rawBook.width,
            height: rawBook.height,
            manualWidth: rawBook.manualWidth,
            manualHeight: rawBook.manualHeight,
            sourcePages: rawBook.sourcePages,
          });
        }
        if (
          item.x + itemWidth(item) > bookcase.width - 2 ||
          itemHeight(item) > shelf.height - SHELF_FLOOR
        )
          return null;
        shelf.items.push(item);
      }
      shelf.items.sort((a, b) => a.x - b.x);
      if (
        shelf.items.some(
          (item, i) =>
            i > 0 &&
            shelf.items[i - 1]!.x + itemWidth(shelf.items[i - 1]!) > item.x,
        )
      )
        return null;
      bookcase.shelves.push(shelf);
    }
    result.bookcases.push(bookcase);
  }
  return result;
}
