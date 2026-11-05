import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyBookStatusChange,
  readingStatusDetails,
} from './bookReadingStatus';

test('saved status updates the loaded record without replacing other books', () => {
  const changed = { id: 'changed', status: 'reading' };
  const other = { id: 'other', status: 'to_be_read' };
  const books = [other, changed];
  applyBookStatusChange({
    books,
    endpoint: '/api/books',
    change: { bookId: 'changed', status: 'finished' },
  });
  assert.equal(books.length, 2);
  assert.equal(books[0], other);
  assert.equal(books[1], changed);
  assert.equal(changed.status, 'finished');
});

test('a status filter removes only a book that no longer matches', () => {
  const other = { id: 'other', status: 'reading' };
  const books = [other, { id: 'changed', status: 'reading' }];
  applyBookStatusChange({
    books,
    endpoint: '/api/books?status=reading',
    change: { bookId: 'changed', status: 'finished' },
  });
  assert.deepEqual(books, [other]);
  assert.equal(books[0], other);
});

test('combined filters retain matching saved statuses and cleared statuses', () => {
  const books: { id: string; status?: string | null }[] = [{ id: 'book' }];
  const endpoint = '/api/books?status=reading%2Cnone&files=none';
  applyBookStatusChange({
    books,
    endpoint,
    change: { bookId: 'book', status: 'reading' },
  });
  assert.equal(books.length, 1);
  applyBookStatusChange({
    books,
    endpoint,
    change: { bookId: 'book', status: null },
  });
  assert.equal(books.length, 1);
  assert.equal(books[0]?.status, null);
  applyBookStatusChange({
    books,
    endpoint,
    change: { bookId: 'book', status: 'dnf' },
  });
  assert.equal(books.length, 0);
});

test('unloaded books cannot replace or remove the loaded results', () => {
  const books = [{ id: 'loaded', status: 'reading' }];
  applyBookStatusChange({
    books,
    endpoint: '/api/authors/author/books',
    change: { bookId: 'unloaded', status: null },
  });
  assert.deepEqual(books, [{ id: 'loaded', status: 'reading' }]);
});

test('unset or unknown statuses have no cover badge', () => {
  assert.equal(readingStatusDetails(null), null);
  assert.equal(readingStatusDetails(undefined), null);
  assert.equal(readingStatusDetails('unknown'), null);
});
