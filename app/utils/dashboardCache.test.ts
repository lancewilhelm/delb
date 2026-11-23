import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearDashboardCache,
  readDashboardCache,
  writeDashboardCache,
} from './dashboardCache';

test('dashboardCache scopes entries by userId/scope/shelf and shares counts across tabs', () => {
  clearDashboardCache();

  writeDashboardCache('user-1', 'all', 'reading', {
    counts: {
      total: 42,
      reading: 3,
      to_be_read: 10,
      finished: 25,
      dnf: 2,
      none: 2,
    },
    shelf: {
      kind: 'reading',
      nextOffset: null,
      books: [
        {
          id: 'book-1',
          title: 'Dune',
          author: 'Frank Herbert',
          authorNames: ['Frank Herbert'],
          authors: [{ id: 'a-1', name: 'Frank Herbert' }],
          coverImagePath: 'covers/dune.webp',
          updatedAt: '2026-01-01T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
          progress: 55,
          finishedDate: null,
        },
      ],
    },
  });

  // Exact hit returns counts + shelf
  const reading = readDashboardCache('user-1', 'all', 'reading');
  assert.equal(reading.counts?.total, 42);
  assert.equal(reading.shelf?.books.length, 1);
  assert.equal(reading.shelf?.books[0]?.title, 'Dune');

  // Different shelf tab in same scope still gets counts (no "—" flash)
  const finished = readDashboardCache('user-1', 'all', 'finished');
  assert.equal(finished.counts?.total, 42);
  assert.equal(finished.shelf, null);

  // Different user gets nothing (no cross-account leak)
  const otherUser = readDashboardCache('user-2', 'all', 'reading');
  assert.equal(otherUser.counts, null);
  assert.equal(otherUser.shelf, null);

  // Empty userId is a no-op
  const anon = readDashboardCache(undefined, 'all', 'reading');
  assert.equal(anon.counts, null);

  clearDashboardCache();
  assert.equal(readDashboardCache('user-1', 'all', 'reading').counts, null);
});
