import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeBookshelfLayout } from '../../../shared/bookshelf-layout';
import type { ShelfBook } from '../../../shared/bookshelf';
const geometry = {
  bookcases: [
    {
      id: 'case',
      width: 120,
      shelves: [{ id: 'row', height: 245, items: [] }],
    },
  ],
};
const book = (id: string, width = 40): ShelfBook => ({
  id,
  width,
  height: 200,
  manualWidth: false,
  manualHeight: false,
  sourcePages: null,
});
const anchor = (stackId: string, x: number) => ({
  caseId: 'case',
  shelfId: 'row',
  stackId,
  x,
  horizontal: false,
  order: 0,
});
test('private composition restores saved positions and appends only selected visible books', () => {
  const members = [
    { book: book('a'), placement: anchor('a', 2) },
    { book: book('b'), placement: anchor('b', 42) },
  ];
  const hidden = composeBookshelfLayout(geometry, [members[0]!], 'shelf');
  assert.deepEqual(
    hidden.arrangement.bookcases[0]!.shelves[0]!.items.map(
      (i) => i.books[0]!.id,
    ),
    ['a'],
  );
  const restored = composeBookshelfLayout(geometry, members, 'shelf');
  assert.deepEqual(
    restored.arrangement.bookcases[0]!.shelves[0]!.items.map((i) => [
      i.books[0]!.id,
      i.x,
    ]),
    [
      ['a', 2],
      ['b', 42],
    ],
  );
});
test('a collision moves only the later book to a deterministic next location', () => {
  const members = [
    { book: book('a', 55), placement: anchor('a', 2) },
    { book: book('b'), placement: anchor('b', 42) },
  ];
  const first = composeBookshelfLayout(geometry, members, 'shelf');
  const second = composeBookshelfLayout(geometry, members, 'shelf');
  assert.deepEqual(first, second);
  assert.equal(first.arrangement.bookcases[0]!.shelves[0]!.items[0]!.x, 2);
  assert.equal(first.arrangement.bookcases[0]!.shelves[0]!.items[1]!.x, 57);
  assert.deepEqual(first.adjustments, ['b']);
});
test('missing rows use stable overflow geometry', () => {
  const placements = Array.from({ length: 4 }, (_, i) => ({
    book: book(String(i), 55),
    placement: anchor(String(i), i * 55 + 2),
  }));
  const first = composeBookshelfLayout(geometry, placements, 'shelf');
  assert.deepEqual(
    first,
    composeBookshelfLayout(geometry, placements, 'shelf'),
  );
  assert.equal(first.arrangement.bookcases.length, 2);
  assert.equal(
    first.arrangement.bookcases.flatMap((c) =>
      c.shelves.flatMap((s) => s.items),
    ).length,
    4,
  );
});

test('a resized or returning book moves rather than displacing unchanged books', () => {
  const resized = { ...anchor('a', 2), width: 40, height: 200 };
  const unchanged = { ...anchor('b', 42), width: 40, height: 200 };
  const result = composeBookshelfLayout(
    geometry,
    [
      { book: book('a', 55), placement: resized },
      { book: book('b'), placement: unchanged },
    ],
    'shelf',
  );
  const items = result.arrangement.bookcases.flatMap((c) =>
    c.shelves.flatMap((s) => s.items),
  );
  assert.equal(items.find((item) => item.books[0]!.id === 'b')!.x, 42);
  assert.deepEqual(result.adjustments, ['a']);
  const returning = composeBookshelfLayout(
    geometry,
    [
      { book: book('a'), placement: { ...anchor('a', 2), dormant: true } },
      { book: book('b'), placement: anchor('b', 2) },
    ],
    'shelf',
  );
  assert.deepEqual(returning.adjustments, ['a']);
  assert.equal(
    returning.arrangement.bookcases[0]!.shelves[0]!.items.find(
      (item) => item.books[0]!.id === 'b',
    )!.x,
    2,
  );
});

test('a resized book leaves an overfull stack without moving the other books', () => {
  const members = Array.from({ length: 6 }, (_, i) => ({
    book: book(String(i), i === 0 ? 55 : 38),
    placement: {
      ...anchor('stack', 2),
      horizontal: true,
      order: i,
      width: 38,
      height: 200,
    },
  }));
  const wide = { bookcases: [{ ...geometry.bookcases[0]!, width: 340 }] };
  const result = composeBookshelfLayout(wide, members, 'shelf');
  const original = result.arrangement.bookcases[0]!.shelves[0]!.items.find(
    (item) => item.x === 2,
  )!;
  assert.deepEqual(
    original.books.map((item) => item.id),
    ['1', '2', '3', '4', '5'],
  );
  assert.deepEqual(result.adjustments, ['0']);
});

test('staggered stack anchors survive a hidden book and its return', () => {
  const wide = { bookcases: [{ ...geometry.bookcases[0]!, width: 340 }] };
  const members = [
    {
      book: book('a'),
      placement: {
        ...anchor('stack', 20),
        bookX: 20,
        horizontal: true,
        order: 0,
      },
    },
    {
      book: book('b'),
      placement: {
        ...anchor('stack', 20),
        bookX: 35,
        horizontal: true,
        order: 1,
      },
    },
  ];
  const visible = composeBookshelfLayout(wide, [members[1]!], 'shelf');
  const single = visible.arrangement.bookcases[0]!.shelves[0]!.items[0]!;
  assert.equal(single.x + (single.books[0]!.offsetX ?? 0), 35);
  const restored = composeBookshelfLayout(wide, members, 'shelf');
  const stack = restored.arrangement.bookcases[0]!.shelves[0]!.items[0]!;
  assert.deepEqual(
    stack.books.map((b) => [b.id, stack.x + (b.offsetX ?? 0)]),
    [
      ['a', 20],
      ['b', 35],
    ],
  );
});
