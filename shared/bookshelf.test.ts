import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  closestPlacement,
  emptyBookshelf,
  itemWidth,
  minimumShelfHeight,
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
});
