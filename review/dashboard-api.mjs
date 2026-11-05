import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { fetchAuth } from './fetch-auth.mjs';

const base = 'http://127.0.0.1:4317';
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
  const hidden = await createBook(b, 'Dashboard private other reader');
  const shared = (
    await request('/api/collections', a.cookie, 'POST', {
      name: 'Dashboard shared',
    })
  ).data.data.collection.id;
  await db.execute({
    sql: "INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES (?,?,'viewer',0)",
    args: [shared, b.id],
  });
  for (const id of [reading, newer])
    await db.execute({
      sql: 'INSERT INTO collection_books(collection_id,book_id,added_by_user_id,added_at) VALUES (?,?,?,0)',
      args: [shared, id, a.id],
    });
  for (const [id, change] of [
    [reading, { status: 'reading' }],
    [older, { status: 'finished', finishedAt: '2026-10-01' }],
    [newer, { status: 'finished', finishedAt: '2026-11-02' }],
    [undated, { status: 'finished' }],
  ]) {
    assert.equal(
      (await request(`/api/books/${id}/status`, a.cookie, 'POST', change))
        .status,
      200,
    );
  }
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
  const first = await request('/api/dashboard', a.cookie);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.equal(
    first.data.data.counts.total,
    4,
    'books in two collections count once',
  );
  assert.deepEqual(
    first.data.data.shelf.books.map((book) => [book.id, book.progress]),
    [[reading, 42]],
  );
  assert.ok(!('userFavorite' in first.data.data.shelf.books[0]));
  const recent = await request('/api/dashboard?shelf=recent', a.cookie);
  assert.deepEqual(
    recent.data.data.shelf.books.map((book) => book.id),
    [newer, older],
  );
  assert.equal(recent.data.data.shelf.books[0].finishedDate, '2026-11-02');
  assert.deepEqual(first.data.data.counts, recent.data.data.counts);
  const scoped = await request(
    `/api/dashboard?shelf=recent&collectionId=${shared}`,
    a.cookie,
  );
  assert.deepEqual(
    scoped.data.data.shelf.books.map((book) => book.id),
    [newer],
  );
  assert.equal(scoped.data.data.counts.total, 2);
  const other = await request('/api/dashboard?shelf=recent', b.cookie);
  assert.deepEqual(
    other.data.data.shelf.books,
    [],
    'shared books do not share personal finish dates',
  );
  assert.equal(other.data.data.counts.total, 3);
  assert.equal(other.data.data.counts.none, 3);
  await db.execute({
    sql: 'DELETE FROM collection_members WHERE collection_id=? AND user_id=?',
    args: [shared, b.id],
  });
  assert.equal(
    (await request('/api/dashboard', b.cookie)).data.data.counts.total,
    1,
  );
  assert.deepEqual(
    (
      await request(
        `/api/dashboard?shelf=recent&collectionId=${shared}`,
        b.cookie,
      )
    ).data.data.shelf.books,
    [],
  );
  assert.ok(!recent.data.data.shelf.books.some((book) => book.id === hidden));
  console.log(
    'PASS dashboard API: auth, validation, collection visibility, finish-date order, private reading history, revoked access, and deferred favorites',
  );
} finally {
  db.close();
}
