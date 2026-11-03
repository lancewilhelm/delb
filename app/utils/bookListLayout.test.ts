import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookListOffsets, bookListWindow } from './bookListLayout';

test('wrapped rows keep distinct offsets and remain reachable at the bottom', () => {
  const offsets = bookListOffsets(
    ['a', 'b', 'c', 'd'],
    new Map([
      ['a', 56],
      ['b', 85],
      ['c', 64],
      ['d', 85],
    ]),
    56,
  );
  assert.deepEqual(offsets, [0, 56, 141, 205, 290]);
  assert.deepEqual(bookListWindow(offsets, 141, 63, 0), {
    startIndex: 2,
    endIndex: 3,
    offsetY: 141,
    totalHeight: 290,
  });
  assert.deepEqual(bookListWindow(offsets, 230, 60, 1), {
    startIndex: 2,
    endIndex: 4,
    offsetY: 141,
    totalHeight: 290,
  });
  assert.equal(bookListOffsets(['unmeasured'], new Map(), 56)[1], 85);
  assert.equal(bookListOffsets(['cover'], new Map(), 160)[1], 160);
});
