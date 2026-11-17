import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  closestPlacement,
  emptyBookshelf,
  itemWidth,
  minimumShelfHeight,
  minimumBookcaseWidth,
  planShelfDrop,
  parseBookshelf,
  reconcileBookshelf,
  shiftStackBook,
  type ShelfBook,
  type ShelfItem,
} from './bookshelf';

const placement = (id: string, width = 30): ShelfBook => ({
  id,
  width,
  height: 200,
  manualWidth: false,
  manualHeight: false,
  sourcePages: null,
});
const item = (id: string, x: number, width = 30): ShelfItem => ({
  x,
  horizontal: false,
  books: [placement(id, width)],
});

describe('personal bookshelf', () => {
  it('shifts one stacked book while respecting shelf boundaries', () => {
    const shelf = emptyBookshelf().bookcases[0]!.shelves[0]!;
    shelf.items = [
      { x: 20, horizontal: true, books: [placement('a'), placement('b')] },
    ];
    const shifted = shiftStackBook(shelf, 340, 'a', -5)!;
    assert.deepEqual(
      shifted[0]!.books.map((book) => shifted[0]!.x + (book.offsetX ?? 0)),
      [15, 20],
    );
    shelf.items = shifted;
    assert.ok(
      parseBookshelf({
        bookcases: [{ id: 'case', width: 340, shelves: [shelf] }],
      }),
    );
    assert.equal(shiftStackBook(shelf, 340, 'a', -20), null);
    assert.deepEqual(shelf.items, shifted);
  });
  it('rejects overlapping, duplicated, and too-tall saved geometry', () => {
    const data = emptyBookshelf();
    const shelf = data.bookcases[0]!.shelves[0]!;
    shelf.items = [item('a', 2), item('b', 32)];
    assert.ok(parseBookshelf(data));
    shelf.items[1]!.x = 31;
    assert.equal(parseBookshelf(data), null);
    shelf.items[1]!.x = 32;
    shelf.items[1]!.books[0]!.id = 'a';
    assert.equal(parseBookshelf(data), null);
    shelf.items[1]!.books[0]!.id = 'b';
    shelf.height = 150;
    assert.equal(parseBookshelf(data), null);
  });
  it('snaps a placement inside the edge without overlapping its neighbors', () => {
    const others = [item('a', 2, 55), item('b', 100, 55)];
    const packed = closestPlacement(others, item('c', 2, 50), 500, 245)!;
    const last = packed.find((entry) => entry.books[0]!.id === 'c')!;
    assert.equal(last.x + itemWidth(last), 338);
    assert.ok(
      packed.every(
        (entry, i) =>
          !i || packed[i - 1]!.x + itemWidth(packed[i - 1]!) <= entry.x,
      ),
    );
  });
  it('uses the height of an entire stack as a shelf minimum', () => {
    const shelf = emptyBookshelf().bookcases[0]!.shelves[0]!;
    shelf.items = [
      {
        x: 2,
        horizontal: true,
        books: [placement('a', 55), placement('b', 55), placement('c', 55)],
      },
    ];
    assert.equal(minimumShelfHeight(shelf), 179);
  });
  it('preserves gaps when access is lost and appends restored books', () => {
    const data = emptyBookshelf();
    const shelf = data.bookcases[0]!.shelves[0]!;
    shelf.items = [item('a', 2), item('b', 100), item('c', 200)];
    const removed = reconcileBookshelf(data, [{ id: 'a' }, { id: 'c' }]);
    assert.deepEqual(
      removed.bookshelf.bookcases[0]!.shelves[0]!.items.map((i) => i.x),
      [2, 200],
    );
    const returned = reconcileBookshelf(removed.bookshelf, [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
    assert.deepEqual(
      returned.bookshelf.bookcases[0]!.shelves.flatMap((s) =>
        s.items.map((i) => i.books[0]!.id),
      ),
      ['a', 'c', 'b'],
    );
  });
  it('updates automatic thickness only if it fits, and keeps manual dimensions', () => {
    const data = emptyBookshelf();
    const shelf = data.bookcases[0]!.shelves[0]!;
    shelf.items = [item('a', 2), item('b', 32), item('c', 180)];
    shelf.items[2]!.books[0]!.manualWidth = true;
    const result = reconcileBookshelf(data, [
      { id: 'a', pages: 800 },
      { id: 'b' },
      { id: 'c', pages: 800 },
    ]);
    assert.equal(
      result.bookshelf.bookcases[0]!.shelves[0]!.items[0]!.books[0]!.width,
      30,
    );
    assert.deepEqual(result.needsAdjustment, ['a']);
    assert.equal(
      result.bookshelf.bookcases[0]!.shelves[0]!.items[2]!.books[0]!.width,
      30,
    );
  });
  it('fills the existing empty shelves in order for a new bookshelf', () => {
    const result = reconcileBookshelf(emptyBookshelf(), [{ id: 'first' }]);
    assert.equal(
      result.bookshelf.bookcases[0]!.shelves[0]!.items[0]!.books[0]!.id,
      'first',
    );
    assert.equal(result.bookshelf.bookcases[0]!.shelves[2]!.items.length, 0);
  });
  it('updates stale automatic dimensions before placing an unshelved book', () => {
    const dimensions = {
      width: 24,
      height: 200,
      manualWidth: false,
      manualHeight: false,
      sourcePages: 100,
    };
    const result = reconcileBookshelf(emptyBookshelf(), [
      { id: 'auto', pages: 900, dimensions },
      {
        id: 'manual',
        pages: 900,
        dimensions: { ...dimensions, manualWidth: true },
      },
    ]);
    const books = result.bookshelf.bookcases[0]!.shelves[0]!.items.map(
      (entry) => entry.books[0]!,
    );
    assert.equal(books[0]!.width, 55);
    assert.equal(books[0]!.sourcePages, 900);
    assert.equal(books[1]!.width, 24);
    assert.equal(books[1]!.manualWidth, true);
    assert.ok(parseBookshelf(result.bookshelf));
  });
  it('adds new shelves for books that do not fit, without disturbing prior positions', () => {
    const data = emptyBookshelf();
    const shelf = data.bookcases[0]!.shelves.at(-1)!;
    shelf.items = [item('a', 300, 30)];
    const result = reconcileBookshelf(data, [
      { id: 'a' },
      { id: 'b', pages: 875 },
    ]);
    assert.equal(result.bookshelf.bookcases.length, 2);
    assert.equal(result.bookshelf.bookcases[0]!.shelves[2]!.items[0]!.x, 300);
    assert.equal(
      result.bookshelf.bookcases[1]!.shelves[0]!.items[0]!.books[0]!.id,
      'b',
    );
  });

  it('converts older individual widths into one safe bookcase width', () => {
    const data = emptyBookshelf();
    const old = JSON.parse(JSON.stringify(data));
    delete old.bookcases[0].width;
    old.bookcases[0].shelves[0].width = 250;
    old.bookcases[0].shelves[1].width = 480;
    old.bookcases[0].shelves[2].width = 300;
    old.bookcases[0].shelves[0].items = [item('a', 180, 55)];
    const converted = parseBookshelf(old)!;
    assert.equal(converted.bookcases[0]!.width, 480);
    assert.equal(converted.bookcases[0]!.shelves[0]!.items[0]!.x, 180);
    const bookcase = converted.bookcases[0]!;
    assert.equal(minimumBookcaseWidth(bookcase), 237);
    bookcase.width = 236;
    assert.equal(parseBookshelf(converted), null);
    bookcase.width = 237;
    assert.ok(parseBookshelf(converted));
    bookcase.width = 500;
    const placed = closestPlacement(
      bookcase.shelves[0]!.items,
      item('b', 2),
      1000,
      245,
      bookcase.width,
    )!;
    assert.equal(placed.find((entry) => entry.books[0]!.id === 'b')!.x, 468);
    bookcase.width = 701;
    assert.equal(parseBookshelf(converted), null);
  });
  it('lays an upright book sideways when dropped near the center of a horizontal book', () => {
    const data = emptyBookshelf();
    const [origin, destination] = data.bookcases[0]!.shelves;
    origin!.items = [item('a', 2), item('other', 80)];
    destination!.items = [{ x: 2, horizontal: true, books: [placement('b')] }];
    const snapshot = JSON.stringify(data);
    const drop = planShelfDrop(
      origin!,
      destination!,
      340,
      'a',
      false,
      100,
      15,
      10,
      185,
    )!;
    assert.ok(drop.valid);
    assert.equal(drop.moving.horizontal, true);
    assert.equal(drop.bottom, 44);
    assert.deepEqual(
      drop.items[0]!.books.map((b) => b.id),
      ['b', 'a'],
    );
    assert.deepEqual(
      drop.sourceItems.map((i) => i.books[0]!.id),
      ['other'],
    );
    assert.equal(JSON.stringify(data), snapshot);
  });
  it('stands an individual book upright when it is dragged out of a stack', () => {
    const data = emptyBookshelf();
    const [origin, destination] = data.bookcases[0]!.shelves;
    origin!.items = [
      { x: 2, horizontal: true, books: [placement('a'), placement('b')] },
    ];
    const drop = planShelfDrop(
      origin!,
      destination!,
      340,
      'b',
      false,
      110,
      100,
      80,
    )!;
    assert.ok(drop.valid);
    assert.equal(drop.moving.horizontal, false);
    assert.equal(drop.items[0]!.horizontal, false);
    assert.equal(drop.items[0]!.books[0]!.id, 'b');
    assert.deepEqual(
      drop.sourceItems[0]!.books.map((b) => b.id),
      ['a'],
    );
    const whole = planShelfDrop(
      origin!,
      destination!,
      340,
      'a',
      true,
      110,
      100,
      80,
    )!;
    assert.ok(whole.valid);
    assert.equal(whole.moving.horizontal, true);
    assert.equal(whole.items[0]!.books.length, 2);
  });
  it('rejects a stack that exceeds shelf height and preserves the original books', () => {
    const data = emptyBookshelf();
    const [origin, destination] = data.bookcases[0]!.shelves;
    origin!.items = [item('a', 2, 55)];
    destination!.height = 130;
    destination!.items = [
      {
        x: 2,
        horizontal: true,
        books: [placement('b', 55), placement('c', 55)],
      },
    ];
    const snapshot = JSON.stringify(data);
    const drop = planShelfDrop(
      origin!,
      destination!,
      340,
      'a',
      false,
      100,
      15,
      10,
    )!;
    assert.equal(drop.valid, false);
    assert.equal(JSON.stringify(data), snapshot);
  });
  it('does not stack when the pointer is outside the center of the horizontal spine', () => {
    const data = emptyBookshelf();
    const [origin, destination] = data.bookcases[0]!.shelves;
    origin!.items = [item('a', 2)];
    destination!.items = [{ x: 2, horizontal: true, books: [placement('b')] }];
    const drop = planShelfDrop(
      origin!,
      destination!,
      340,
      'a',
      false,
      210,
      15,
      10,
      185,
    )!;
    assert.ok(drop.valid);
    assert.equal(drop.moving.horizontal, false);
    assert.equal(
      drop.items.find((i) => i.books.some((b) => b.id === 'a'))!.horizontal,
      false,
    );
  });
  it('stacks and unstacks books within the same shelf without duplicates', () => {
    const shelf = emptyBookshelf().bookcases[0]!.shelves[0]!;
    shelf.items = [
      item('a', 2),
      { x: 80, horizontal: true, books: [placement('b')] },
    ];
    const stacked = planShelfDrop(shelf, shelf, 340, 'a', false, 180, 15, 10)!;
    assert.ok(stacked.valid);
    assert.deepEqual(
      stacked.items.flatMap((i) => i.books.map((b) => b.id)).sort(),
      ['a', 'b'],
    );
    assert.equal(stacked.items.length, 1);
    shelf.items = stacked.items;
    const unstacked = planShelfDrop(
      shelf,
      shelf,
      340,
      'a',
      false,
      280,
      100,
      30,
    )!;
    assert.ok(unstacked.valid);
    assert.deepEqual(
      unstacked.items.flatMap((i) => i.books.map((b) => b.id)).sort(),
      ['a', 'b'],
    );
    assert.equal(
      unstacked.items.find((i) => i.books.some((b) => b.id === 'a'))!
        .horizontal,
      false,
    );
    assert.equal(
      unstacked.items.find((i) => i.books.some((b) => b.id === 'b'))!
        .horizontal,
      true,
    );
  });
  it('keeps a sideways book flat when it is dragged along the shelf', () => {
    const shelf = emptyBookshelf().bookcases[0]!.shelves[0]!;
    shelf.items = [{ x: 2, horizontal: true, books: [placement('flat')] }];
    const drop = planShelfDrop(shelf, shelf, 340, 'flat', false, 120, 15, 50)!;
    assert.ok(drop.valid);
    assert.equal(drop.moving.horizontal, true);
    assert.equal(drop.items[0]!.horizontal, true);
    assert.equal(drop.items[0]!.x, 70);
  });
  it('stands a sideways book upright only after it is lifted above its grab point', () => {
    const shelf = emptyBookshelf().bookcases[0]!.shelves[0]!;
    shelf.items = [{ x: 2, horizontal: true, books: [placement('flat')] }];
    const near = planShelfDrop(
      shelf,
      shelf,
      340,
      'flat',
      false,
      120,
      47,
      50,
      15,
    )!;
    const lifted = planShelfDrop(
      shelf,
      shelf,
      340,
      'flat',
      false,
      120,
      48,
      50,
      15,
    )!;
    assert.equal(near.moving.horizontal, true);
    assert.equal(lifted.moving.horizontal, false);
    assert.ok(lifted.valid);
    assert.equal(lifted.items[0]!.horizontal, false);
  });
  it('uses a stacked book’s original height to distinguish sliding from lifting', () => {
    const [origin, destination] = emptyBookshelf().bookcases[0]!.shelves;
    origin!.items = [
      {
        x: 2,
        horizontal: true,
        books: [placement('a'), placement('b'), placement('c')],
      },
    ];
    const slide = planShelfDrop(
      origin!,
      destination!,
      340,
      'c',
      false,
      120,
      75,
      50,
      15,
    )!;
    const lift = planShelfDrop(
      origin!,
      destination!,
      340,
      'c',
      false,
      120,
      108,
      50,
      15,
    )!;
    assert.ok(slide.valid);
    assert.equal(slide.moving.horizontal, true);
    assert.equal(lift.moving.horizontal, false);
    assert.deepEqual(
      slide.sourceItems[0]!.books.map((book) => book.id),
      ['a', 'b'],
    );
  });
  it('lays an upright book down when it is pulled toward the shelf', () => {
    const shelf = emptyBookshelf().bookcases[0]!.shelves[0]!;
    shelf.items = [item('upright', 2)];
    const drop = planShelfDrop(
      shelf,
      shelf,
      340,
      'upright',
      false,
      110,
      60,
      15,
      100,
    )!;
    assert.ok(drop.valid);
    assert.equal(drop.moving.horizontal, true);
    assert.equal(drop.items[0]!.horizontal, true);
  });
  it('keeps an upright book standing during a level drag and small downward movement', () => {
    const shelf = emptyBookshelf().bookcases[0]!.shelves[0]!;
    shelf.items = [item('upright', 2)];
    const level = planShelfDrop(
      shelf,
      shelf,
      340,
      'upright',
      false,
      110,
      100,
      15,
      100,
    )!;
    const small = planShelfDrop(
      shelf,
      shelf,
      340,
      'upright',
      false,
      110,
      69,
      15,
      100,
    )!;
    const pulled = planShelfDrop(
      shelf,
      shelf,
      340,
      'upright',
      false,
      110,
      68,
      15,
      100,
    )!;
    assert.equal(level.moving.horizontal, false);
    assert.equal(small.moving.horizontal, false);
    assert.equal(pulled.moving.horizontal, true);
  });
  it('allows a downward pull when a book is grabbed near its bottom', () => {
    const shelf = emptyBookshelf().bookcases[0]!.shelves[0]!;
    shelf.items = [item('upright', 2)];
    const drop = planShelfDrop(
      shelf,
      shelf,
      340,
      'upright',
      false,
      110,
      -3,
      15,
      195,
    )!;
    assert.ok(drop.valid);
    assert.equal(drop.moving.horizontal, true);
  });
  it('does not lay a book down when the sideways position cannot fit', () => {
    const shelf = emptyBookshelf().bookcases[0]!.shelves[0]!;
    shelf.items = [item('upright', 2), item('neighbor', 40)];
    const snapshot = JSON.stringify(shelf);
    const drop = planShelfDrop(
      shelf,
      shelf,
      220,
      'upright',
      false,
      110,
      60,
      15,
      100,
    )!;
    assert.equal(drop.moving.horizontal, true);
    assert.equal(drop.valid, false);
    assert.equal(JSON.stringify(shelf), snapshot);
  });
});
