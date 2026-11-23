import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelBookDetailPrefetch,
  clearBookPreviewCache,
  fetchBookDetail,
  getBookPreview,
  getCachedBookDetail,
  invalidateBookDetail,
  primeBookPreviews,
  scheduleBookDetailPrefetch,
} from './bookPreviewCache';

test('primeBookPreviews seeds preview metadata and normalizes authors/status', () => {
  clearBookPreviewCache();
  primeBookPreviews([
    {
      id: 'b-1',
      title: 'Dune',
      authorNames: ['Frank Herbert'],
      coverImagePath: 'covers/dune.webp',
      updatedAt: '2026-01-01T00:00:00Z',
      status: 'reading',
      series: { id: 's-1', name: 'Dune Chronicles' },
      seriesIndex: 1,
    },
    {
      id: '__row-sizer__',
      title: 'Sample Title',
    },
  ]);

  assert.equal(getBookPreview('__row-sizer__'), null);
  const preview = getBookPreview('b-1');
  assert.ok(preview);
  assert.equal(preview.title, 'Dune');
  assert.equal(preview.userStatus, 'reading');
  assert.equal(preview.coverImagePath, 'covers/dune.webp');
  assert.equal(preview.authors?.[0]?.name, 'Frank Herbert');
  assert.equal(preview.series?.index, 1);

  // Returning a clone prevents caller mutations from polluting the cache.
  preview.title = 'Mutated';
  assert.equal(getBookPreview('b-1')?.title, 'Dune');
  clearBookPreviewCache();
});

test('fetchBookDetail deduplicates in-flight requests and caches detail responses', async () => {
  clearBookPreviewCache();
  let calls = 0;
  let resolveFetch: ((value: Response) => void) | null = null;

  const mockFetch: typeof fetch = () => {
    calls += 1;
    return new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
  };

  const p1 = fetchBookDetail('b-2', { fetcher: mockFetch });
  const p2 = fetchBookDetail('b-2', { fetcher: mockFetch });
  assert.equal(calls, 1, 'concurrent callers share one in-flight request');

  resolveFetch!(
    new Response(
      JSON.stringify({
        success: true,
        data: {
          book: { id: 'b-2', title: 'Hyperion', createdAt: 1 },
          authors: [{ id: 'a-1', name: 'Dan Simmons' }],
          files: [{ id: 'f-1', format: 'epub', relativePath: 'hyperion.epub' }],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1?.title, 'Hyperion');
  assert.equal(r1?.authors?.[0]?.name, 'Dan Simmons');
  assert.equal(r1?.files?.[0]?.format, 'epub');
  assert.equal(r2?.title, 'Hyperion');

  // Subsequent fetch within TTL returns cached copy without hitting network.
  const r3 = await fetchBookDetail('b-2', { fetcher: mockFetch });
  assert.equal(calls, 1);
  assert.equal(r3?.title, 'Hyperion');
  assert.equal(getCachedBookDetail('b-2')?.title, 'Hyperion');

  // Invalidation forces next fetch to hit the network again.
  invalidateBookDetail('b-2');
  assert.equal(getCachedBookDetail('b-2'), null);
  assert.equal(getBookPreview('b-2'), null);
  clearBookPreviewCache();
});

test('cancelBookDetailPrefetch prevents firing before delay expires', async () => {
  clearBookPreviewCache();
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response(
      JSON.stringify({
        success: true,
        data: { book: { id: 'b-3', title: 'Neuromancer', createdAt: 1 } },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    scheduleBookDetailPrefetch('b-3', 30);
    cancelBookDetailPrefetch('b-3');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fetched, 0, 'cancelled hover prefetch does not fetch');
  } finally {
    globalThis.fetch = originalFetch;
    clearBookPreviewCache();
  }
});
