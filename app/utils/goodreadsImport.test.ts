import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  batches,
  buildApplyItem,
  defaultChoice,
  defaultStatusFor,
  defaultStatusMap,
  delbRating,
  findConflict,
  hasConflict,
  starsText,
  type ExistingReading,
  type GoodreadsRow,
  type ImportInclude,
} from './goodreadsImport';

const all: ImportInclude = {
  statuses: true,
  ratings: true,
  reviews: true,
  notes: true,
  shelves: true,
};

function row(overrides: Partial<GoodreadsRow> = {}): GoodreadsRow {
  return {
    index: 0,
    goodreadsId: '1',
    title: 'Dune',
    fullTitle: 'Dune (Dune #1)',
    authors: ['Frank Herbert'],
    rating: 4,
    exclusiveShelf: 'read',
    dateRead: '2023-05-14',
    shelves: [],
    match: { kind: 'isbn', bookId: 'b1', candidates: [] },
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingReading> = {}): ExistingReading {
  return {
    status: 'finished',
    endedDate: '2023-05-14',
    rating: 8,
    review: '',
    hasReview: false,
    tbrRank: null,
    ...overrides,
  };
}

test('standard and DNF-like shelves map to Delb statuses', () => {
  assert.equal(defaultStatusFor('read'), 'finished');
  assert.equal(defaultStatusFor('currently-reading'), 'reading');
  assert.equal(defaultStatusFor('to-read'), 'to_be_read');
  assert.equal(defaultStatusFor('did-not-finish'), 'dnf');
  assert.equal(defaultStatusFor('dnf'), 'dnf');
  assert.equal(defaultStatusFor('abandoned'), 'dnf');
  assert.equal(defaultStatusFor('owned'), null);
  assert.deepEqual(
    defaultStatusMap([
      { name: 'read', count: 2 },
      { name: 'wishlist', count: 1 },
    ]),
    { read: 'finished', wishlist: null },
  );
});

test('ratings double onto the half-star scale', () => {
  assert.equal(delbRating(0), null);
  assert.equal(delbRating(3), 6);
  assert.equal(starsText(7), '★★★½');
  assert.equal(starsText(null), '');
});

test('matching values are not conflicts', () => {
  const c = findConflict(row(), existing(), { read: 'finished' }, all);
  assert.equal(hasConflict(c), false);
});

test('a different finish date, rating, or review is a conflict', () => {
  const c = findConflict(
    row({ dateRead: '2024-01-01', rating: 5, review: 'New' }),
    existing({ review: 'Old', hasReview: true }),
    { read: 'finished' },
    all,
  );
  assert.deepEqual(c, { status: true, rating: true, review: true });
});

test('a missing Delb value or an excluded field is not a conflict', () => {
  const c = findConflict(
    row({ rating: 5 }),
    existing({ status: null, rating: null }),
    { read: 'finished' },
    all,
  );
  assert.equal(hasConflict(c), false);
  const skipped = findConflict(
    row({ rating: 5, exclusiveShelf: 'to-read' }),
    existing(),
    { 'to-read': 'to_be_read' },
    { ...all, statuses: false, ratings: false },
  );
  assert.equal(hasConflict(skipped), false);
});

test('unmatched rows default to no Delb book', () => {
  assert.equal(defaultChoice(row()), 'b1');
  assert.equal(
    defaultChoice(
      row({ match: { kind: 'none', bookId: undefined, candidates: [] } }),
    ),
    null,
  );
});

test('apply items carry the row data the server needs', () => {
  const item = buildApplyItem(
    row({ tbrPosition: 3, shelves: ['sci-fi'] }),
    'b9',
    true,
  );
  assert.equal(item.bookId, 'b9');
  assert.equal(item.tbrPosition, 3);
  assert.equal(item.overwrite, true);
  assert.deepEqual(item.shelves, ['sci-fi']);
  assert.equal(item.review, '');
});

test('batches split without dropping items', () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batches([], 3), []);
});
