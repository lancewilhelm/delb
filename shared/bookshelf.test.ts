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
});
