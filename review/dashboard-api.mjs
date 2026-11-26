import { setTagRules, tagBook } from './library-fixtures.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from './sqlite-client.mjs';
import { fetchAuth } from './fetch-auth.mjs';

const base = (
  process.env.DELB_REVIEW_URL ||
  process.env.BASE_URL ||
  'http://127.0.0.1:4317'
).replace(/\/$/, '');
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
async function request(path, cookie, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    headers: response.headers,
    data: await response.json(),
  };
}
async function signup(label) {
  const response = await fetchAuth(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Dashboard ${label}`,
      email: `dashboard-${label}-${randomBytes(5).toString('hex')}@example.invalid`,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const json = await response.json();
  return {
    id: json.user.id,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
const a = await signup('a');
const b = await signup('b');
async function createBook(user, title) {
  const result = await request('/api/books', user.cookie, 'POST', {
    title,
    authors: ['Dashboard Author'],
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.data.book.id;
}
try {
  const reading = await createBook(a, 'Dashboard reading');
  const older = await createBook(a, 'Dashboard older finished');
  const newer = await createBook(a, 'Dashboard newer finished');
  const undated = await createBook(a, 'Dashboard undated finished');
  const hidden = await createBook(a, 'Dashboard hidden book');
  const queued = await createBook(a, 'Dashboard queued');
  const sharedTag = await tagBook(a, reading, 'Shared dashboard');
  await tagBook(a, newer, sharedTag.name);
  await tagBook(a, hidden, sharedTag.name);
  await setTagRules(a, b, { allowTagIds: [sharedTag.id] });
  for (const [id, change] of [
    [reading, { status: 'reading' }],
    [older, { status: 'finished', finishedAt: '2026-10-01' }],
    [newer, { status: 'finished', finishedAt: '2026-11-02' }],
    [undated, { status: 'finished' }],
    [queued, { status: 'to_be_read' }],
  ]) {
    assert.equal(
      (await request(`/api/books/${id}/status`, a.cookie, 'POST', change))
        .status,
      200,
    );
  }
  const titlePage = await request(
    '/api/books?title=dashboard&status=finished&sort=alphabetical&sortDir=asc&limit=1',
    a.cookie,
  );
  assert.equal(titlePage.status, 200);
  const matchingFinished = [
    ...titlePage.data.data.books.map((book) => book.id),
  ];
  let titleCursor = titlePage.data.data.nextCursor;
  while (titleCursor) {
    const next = await request(
      `/api/books?title=dashboard&status=finished&sort=alphabetical&sortDir=asc&limit=1&cursor=${encodeURIComponent(titleCursor)}`,
      a.cookie,
    );
    assert.equal(next.status, 200);
    matchingFinished.push(...next.data.data.books.map((book) => book.id));
    titleCursor = next.data.data.nextCursor;
  }
  assert.deepEqual(new Set(matchingFinished), new Set([older, newer, undated]));
  const scopedTitle = await request('/api/books?title=READING', a.cookie);
  assert.deepEqual(
    scopedTitle.data.data.books.map((book) => book.id),
    [reading],
  );
  const privateTitle = await request('/api/books?title=older', b.cookie);
  assert.deepEqual(privateTitle.data.data.books, []);
  const mismatchedStatus = await request(
    '/api/books?title=reading&status=finished',
    a.cookie,
  );
  assert.deepEqual(mismatchedStatus.data.data.books, []);

  await db.execute({
    sql: 'UPDATE user_book_status SET finished_at=NULL WHERE book_id=? AND user_id=?',
    args: [undated, a.id],
  });
  assert.equal(
    (
      await request(`/api/books/${reading}/reading-position`, a.cookie, 'PUT', {
        location: 'fixture-location',
        progress: 42,
      })
    ).status,
    200,
  );

  assert.equal((await request('/api/dashboard')).status, 401);
  assert.equal(
    (await request('/api/dashboard?shelf=unknown', a.cookie)).status,
    400,
  );
  assert.equal(
    (await request('/api/dashboard?shelf=favorites', a.cookie)).status,
    400,
  );
  assert.equal(
    (await request('/api/dashboard?shelf=recent', a.cookie)).status,
    400,
  );
  assert.equal(
    (await request('/api/dashboard?offset=-1', a.cookie)).status,
    400,
  );
  assert.equal(
    (
      await request(`/api/books/${reading}/favorite`, a.cookie, 'PUT', {
        favorite: true,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request('/api/books/bulk/copies', a.cookie, 'POST', {
        bookIds: [reading],
        physical: true,
        audiobook: true,
      })
    ).status,
    200,
  );
  const first = await request('/api/dashboard', a.cookie);
  assert.equal(first.data.data.shelf.books[0].hasPhysicalCopy, true);
  assert.equal(first.data.data.shelf.books[0].hasAudiobookCopy, true);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.equal(
    first.data.data.counts.total,
    6,
    'every library book is counted once for the owner',
  );
  assert.equal(first.data.data.counts.to_be_read, 1);
  assert.deepEqual(
    first.data.data.shelf.books.map((book) => [book.id, book.progress]),
    [[reading, 42]],
  );
  assert.ok(!('userFavorite' in first.data.data.shelf.books[0]));
  const recent = await request('/api/dashboard?shelf=finished', a.cookie);
  assert.deepEqual(
    recent.data.data.shelf.books.map((book) => book.id),
    [newer, older],
  );
  assert.equal(recent.data.data.shelf.books[0].finishedDate, '2026-11-02');
  assert.deepEqual(first.data.data.counts, recent.data.data.counts);
  const tbr = await request('/api/dashboard?shelf=tbr', a.cookie);
  assert.equal(tbr.data.data.shelf.kind, 'tbr');
  assert.deepEqual(
    tbr.data.data.shelf.books.map((book) => book.id),
    [queued],
  );
  const other = await request('/api/dashboard?shelf=finished', b.cookie);
  assert.deepEqual(
    other.data.data.shelf.books,
    [],
    'shared books do not share personal finish dates',
  );
  assert.equal(other.data.data.counts.total, 3);
  assert.equal(other.data.data.counts.none, 3);
  assert.equal((await request('/api/dashboard/overview')).status, 401);
  const overview = await request('/api/dashboard/overview', a.cookie);
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(overview.data.data.counts, first.data.data.counts);
  assert.equal(overview.data.data.recent.length, 6);
  assert.deepEqual(
    overview.data.data.lists.reading.map((book) => [book.id, book.progress]),
    [[reading, 42]],
  );
  assert.deepEqual(
    overview.data.data.lists.finished.map((book) => book.id),
    [newer, older, undated],
    'overview Finished keeps undated books, last',
  );
  assert.deepEqual(
    overview.data.data.lists.to_be_read.map((book) => book.id),
    [queued],
  );
  assert.equal((await request('/api/dashboard/recent')).status, 401);
  assert.equal(
    (await request('/api/dashboard/recent?offset=-1', a.cookie)).status,
    400,
  );
  const recentPage = await request('/api/dashboard/recent?offset=2', a.cookie);
  assert.equal(recentPage.status, 200);
  assert.deepEqual(
    recentPage.data.data.books.map((book) => book.id),
    overview.data.data.recent.slice(2).map((book) => book.id),
    'wall pages continue the overview order',
  );
  assert.equal(recentPage.data.data.nextOffset, null);
  const overviewOther = await request('/api/dashboard/overview', b.cookie);
  assert.deepEqual(
    overviewOther.data.data.lists.finished,
    [],
    'overview lists use only the reader’s own statuses',
  );
  assert.equal(overviewOther.data.data.lists.none.length, 3);
  const hiddenTag = await tagBook(a, hidden, 'Dashboard exception');
  await setTagRules(a, b, {
    allowTagIds: [sharedTag.id],
    blockTagIds: [hiddenTag.id],
  });
  const restricted = await request('/api/dashboard/overview', b.cookie);
  assert.equal(restricted.data.data.counts.total, 2);
  assert.ok(!restricted.data.data.recent.some((book) => book.id === hidden));
  assert.ok(!recent.data.data.shelf.books.some((book) => book.id === hidden));
  console.log(
    'PASS dashboard API: auth, validation, tag visibility, finish-date order, overview lists, private reading history, revoked access, and deferred favorites',
  );
} finally {
  db.close();
}
