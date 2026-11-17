import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyBookshelf, type ShelfBook } from './bookshelf';
import {
  booksInRectangle,
  bookshelfRows,
  moveSelectedBooks,
} from './bookshelf-selection';

const book = (id: string): ShelfBook => ({
  id,
  width: 30,
  height: 180,
  manualWidth: false,
  manualHeight: false,
  sourcePages: null,
});
test('bookcase gaps are included in selection and cross-case moves', () => {
  const layout = example();
  const original = layout.bookcases[0]!;
  const second = structuredClone(original);
  second.id = 'second';
  second.shelves.forEach((shelf, index) => {
    shelf.id = `second-${index}`;
    shelf.items = [];
  });
  layout.bookcases.push(second);
  assert.equal(
    bookshelfRows(layout).find((row) => row.shelf.id === 'second-0')!.left,
    original.width + 10,
  );
  const moved = moveSelectedBooks(
    layout,
    new Set(['a', 'b']),
    original.shelves[0]!.id,
    second.shelves[0]!.id,
    original.width + 10,
  )!;
  assert.ok(moved);
  assert.deepEqual(
    moved.bookcases[1]!.shelves[0]!.items.map((item) => item.x),
    [10, 50],
  );
  assert.deepEqual(
    [
      ...booksInRectangle(moved, {
        left: 350,
        right: 440,
        bottom: 500,
        top: 710,
      }),
    ],
    ['a', 'b'],
  );
});
function example() {
  const layout = emptyBookshelf();
  const shelves = layout.bookcases[0]!.shelves;
  shelves[0]!.items = [
    { x: 10, horizontal: false, books: [book('a')] },
    { x: 50, horizontal: false, books: [book('b')] },
  ];
  shelves[1]!.items = [{ x: 200, horizontal: false, books: [book('c')] }];
  return layout;
}
test('marquee intersects individual books in wall coordinates', () => {
  const layout = example();
  assert.deepEqual(
    [
      ...booksInRectangle(layout, {
        left: 0,
        right: 90,
        bottom: 500,
        top: 710,
      }),
    ],
    ['a', 'b'],
  );
});
test('group move preserves spacing and rejects collisions without changing the original', () => {
  const layout = example();
  const original = structuredClone(layout);
  const [source, target] = layout.bookcases[0]!.shelves;
  const moved = moveSelectedBooks(
    layout,
    new Set(['a', 'b']),
    source!.id,
    target!.id,
    20,
  )!;
  assert.ok(moved);
  assert.deepEqual(
    moved.bookcases[0]!.shelves[1]!.items.map((item) => [
      item.books[0]!.id,
      item.x,
    ]),
    [
      ['a', 30],
      ['b', 70],
      ['c', 200],
    ],
  );
  assert.equal(
    moveSelectedBooks(layout, new Set(['a', 'b']), source!.id, target!.id, 165),
    null,
  );
  assert.deepEqual(layout, original);
});
