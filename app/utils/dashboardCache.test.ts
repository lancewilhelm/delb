import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearDashboardCache,
  readDashboardCache,
  readShelvesCache,
  writeDashboardCache,
  writeShelvesCache,
} from './dashboardCache';
import type { DashboardOverview } from '#shared/types/dashboard';

const overview = (total: number): DashboardOverview => ({
  counts: {
    total,
    reading: 1,
    to_be_read: 0,
    finished: 0,
    dnf: 0,
    none: total - 1,
  },
  recent: [
    {
      id: 'book-1',
      title: 'Dune',
      coverImagePath: 'covers/dune.webp',
      hasPhysicalCopy: false,
      hasAudiobookCopy: false,
      updatedAt: '2026-01-01T00:00:00Z',
      progress: 55,
      finishedDate: null,
    },
  ],
  lists: { reading: [], to_be_read: [], finished: [], dnf: [], none: [] },
});

test('dashboardCache scopes overviews by user', () => {
  clearDashboardCache();
  writeDashboardCache('user-1', overview(42));

  assert.equal(readDashboardCache('user-1')?.counts.total, 42);
  // No cross-account leak, and anonymous reads are a no-op.
  assert.equal(readDashboardCache('user-2'), null);
  assert.equal(readDashboardCache(undefined), null);

  // Callers get copies, so mutating a read does not corrupt the cache.
  const copy = readDashboardCache('user-1')!;
  copy.recent[0]!.title = 'Changed';
  assert.equal(readDashboardCache('user-1')?.recent[0]?.title, 'Dune');

  clearDashboardCache();
  assert.equal(readDashboardCache('user-1'), null);
});

test('dashboardCache keeps personal shelves per user', () => {
  clearDashboardCache();
  writeShelvesCache('user-1', [
    { id: 's1', name: 'Favs', count: 1, previews: [{ id: 'b', title: 'B' }] },
  ]);
  assert.equal(readShelvesCache('user-1')?.[0]?.name, 'Favs');
  assert.equal(readShelvesCache('user-2'), null);
  clearDashboardCache();
  assert.equal(readShelvesCache('user-1'), null);
});
