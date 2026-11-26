import assert from 'node:assert/strict';
import test from 'node:test';
import { estimatedWidth, stableHeight } from '../../shared/bookshelf.ts';
import {
  DASHBOARD_SHELF_INSET,
  DASHBOARD_SPINE_MAX_HEIGHT,
  fillShelf,
  spineSize,
} from './dashboardShelf.ts';

test('spines use the stored bookshelf size, else the bookshelf estimate', () => {
  assert.deepEqual(
    spineSize({ id: 'a', title: 'A', shelfWidth: 40, shelfHeight: 190 }),
    { width: 40, height: 190 },
  );
  assert.deepEqual(spineSize({ id: 'b', title: 'B', pages: 500 }), {
    width: estimatedWidth(500),
    height: stableHeight('b'),
  });
});

test('a shelf is one centered row that leaves out books that do not fit', () => {
  const books = Array.from({ length: 10 }, (_, i) => ({
    id: `b${i}`,
    title: `B${i}`,
    shelfWidth: 30,
    shelfHeight: 400,
  }));
  // Room for three 30-unit spines (plus 1-unit gaps).
  const width = DASHBOARD_SHELF_INSET * 2 + 30 * 3 + 2;
  const row = fillShelf(books, width);
  assert.deepEqual(
    row.map((spine) => spine.book.id),
    ['b0', 'b1', 'b2'],
  );
  assert.equal(row[0]!.x, DASHBOARD_SHELF_INSET);
  assert.equal(row[1]!.x, DASHBOARD_SHELF_INSET + 31);
  assert.equal(
    row[0]!.height,
    DASHBOARD_SPINE_MAX_HEIGHT,
    'a tall spine is cut down',
  );

  const short = fillShelf(books.slice(0, 1), width);
  assert.equal(short[0]!.x, (width - 30) / 2, 'a short row is centered');
  assert.deepEqual(fillShelf(books, 20), [], 'nothing fits a tiny row');
});
