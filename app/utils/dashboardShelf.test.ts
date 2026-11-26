import assert from 'node:assert/strict';
import test from 'node:test';
import { estimatedWidth, stableHeight } from '../../shared/bookshelf.ts';
import {
  DASHBOARD_SPINE_MAX_HEIGHT,
  fillShelf,
  spineSize,
} from './dashboardShelf.ts';

const books = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `b${i}`,
    title: `B${i}`,
    shelfWidth: 30,
    shelfHeight: 400,
  }));
const ids = (row: ReturnType<typeof fillShelf>) =>
  row.spines.map((spine) => spine.book.id);

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

test('a row that fits is centered, or runs off the right end at a spine middle', () => {
  const width = 200;
  const centered = fillShelf(books(2), width);
  assert.equal(centered.overflows, false);
  assert.equal(centered.spines[0]!.x, (width - 61) / 2);
  assert.equal(
    centered.spines[0]!.height,
    DASHBOARD_SPINE_MAX_HEIGHT,
    'a tall spine is cut down',
  );
  const end = fillShelf(books(2), width, 'end');
  assert.equal(end.overflows, false);
  assert.equal(
    end.spines[1]!.x + 15,
    width,
    'the edge cuts the last spine in half',
  );
  assert.equal(end.spines[0]!.x, width - 46);
});

test('a long row runs past the edges and shows only spines in view', () => {
  // Ten 30-unit spines with 1-unit gaps make a 309-unit row.
  const centered = fillShelf(books(10), 100);
  assert.equal(centered.overflows, true);
  assert.ok(centered.spines[0]!.x < 0, 'cut at the left end');
  const last = centered.spines.at(-1)!;
  assert.ok(last.x + last.width > 100, 'cut at the right end');
  assert.deepEqual(ids(centered), ['b3', 'b4', 'b5', 'b6']);

  // b3 (93–123) reaches the right end; the edge moves to its middle.
  const end = fillShelf(books(10), 100, 'end');
  assert.equal(end.spines.at(-1)!.book.id, 'b3');
  assert.equal(end.spines.at(-1)!.x + 15, 100, 'the edge cuts b3 in half');
  assert.deepEqual(ids(end), ['b0', 'b1', 'b2', 'b3']);
});
