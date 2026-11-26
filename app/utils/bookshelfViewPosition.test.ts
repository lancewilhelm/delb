import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bookshelfViewKey,
  readBookshelfView,
  saveBookshelfView,
} from './bookshelfViewPosition';

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

test('view positions are isolated by user and shelf and survive a read', () => {
  const storage = memoryStorage();
  const first = bookshelfViewKey('user-1', '/api/library/bookshelf');
  const second = bookshelfViewKey('user-1', '/api/shelves/second');
  const otherUser = bookshelfViewKey('user-2', '/api/library/bookshelf');
  saveBookshelfView(storage, first, { x: -1000, y: 30, zoom: 1.7 });
  saveBookshelfView(storage, second, { x: -40, y: -20, zoom: 0.8 });
  assert.deepEqual(readBookshelfView(storage, first), {
    x: -1000,
    y: 30,
    zoom: 1.7,
  });
  assert.deepEqual(readBookshelfView(storage, second), {
    x: -40,
    y: -20,
    zoom: 0.8,
  });
  assert.equal(readBookshelfView(storage, otherUser), null);
  saveBookshelfView(storage, first, { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(readBookshelfView(storage, first), { x: 0, y: 0, zoom: 1 });
});

test('invalid or unavailable browser storage does not prevent using a bookshelf', () => {
  const storage = memoryStorage();
  for (const invalid of [
    '{',
    '{}',
    '{"x":0,"y":0,"zoom":100}',
    '{"x":"0","y":0,"zoom":1}',
  ]) {
    storage.setItem('view', invalid);
    assert.equal(readBookshelfView(storage, 'view'), null);
  }
  storage.getItem = () => {
    throw new Error('blocked');
  };
  storage.setItem = () => {
    throw new Error('blocked');
  };
  assert.equal(readBookshelfView(storage, 'view'), null);
  assert.doesNotThrow(() =>
    saveBookshelfView(storage, 'view', { x: 0, y: 0, zoom: 1 }),
  );
});
