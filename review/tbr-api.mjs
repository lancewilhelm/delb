import { setTagRules } from './library-fixtures.mjs';
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
  return { status: response.status, data: await response.json() };
}
async function signup(name) {
  const email = `tbr-${name}-${randomBytes(5).toString('hex')}@example.invalid`;
  const response = await fetchAuth(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      email,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const { user } = await response.json();
  return {
    id: user.id,
    email,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
  };
}
const owner = await signup('owner');
const reader = await signup('reader');
const ids = Array.from(
  { length: 63 },
  (_, i) => `tbr-book-${String(i).padStart(2, '0')}`,
);
try {
  await db.execute(
    "INSERT INTO tags(id,name,created_at,updated_at) VALUES ('tbr-hidden','Hidden queue fixture',1,1)",
  );
  for (const id of ids) {
    await db.execute({
      sql: 'INSERT INTO books(id,title,created_at,updated_at,created_by_user_id) VALUES (?,?,1,1,?)',
      args: [id, id, owner.id],
    });
  }
  await db.execute({
    sql: "INSERT INTO book_tags(book_id,tag_id) SELECT id,'tbr-hidden' FROM books WHERE id<>?",
    args: [ids[0]],
  });

  assert.equal((await request('/api/tbr')).status, 401);
  assert.equal((await request(`/api/books/${ids[0]}/rationale`)).status, 401);
  assert.equal(
    (
      await request('/api/books/bulk/status', reader.cookie, 'POST', {
        bookIds: ids,
        status: 'to_be_read',
      })
    ).status,
    200,
  );
  const queue = async () => {
    const result = await request('/api/tbr', reader.cookie);
    assert.equal(result.status, 200);
    return result.data.data;
  };
  assert.equal((await queue()).count, 63);
  assert.equal(new Set((await queue()).books.map((book) => book.id)).size, 63);
  const allDashboard = await request('/api/dashboard', reader.cookie);
  assert.equal(allDashboard.data.data.counts.to_be_read, 63);
  assert.equal((await request('/api/tbr', owner.cookie)).data.data.count, 0);
  console.log(
    'PASS TBR authentication, full queue, deduplication and library dashboard count',
  );

  const notePath = `/api/books/${ids[1]}/rationale`;
  assert.equal(
    (
      await request(notePath, reader.cookie, 'PUT', {
        rationale: '  Reader reason  ',
      })
    ).data.data.rationale,
    'Reader reason',
  );
  assert.equal((await request(notePath, owner.cookie)).data.data.rationale, '');
  await request(notePath, owner.cookie, 'PUT', {
    rationale: 'Owner reason',
    userId: reader.id,
  });
  assert.equal(
    (await request(notePath, reader.cookie)).data.data.rationale,
    'Reader reason',
  );
  assert.equal(
    (await request(notePath, reader.cookie, 'PUT', { rationale: {} })).status,
    400,
  );
  assert.equal(
    (
      await request(notePath, reader.cookie, 'PUT', {
        rationale: 'x'.repeat(10001),
      })
    ).status,
    400,
  );
  assert.equal(
    (await queue()).books.find((book) => book.id === ids[1]).rationale,
    'Reader reason',
  );
  console.log(
    'PASS private rationale, input validation and shared read surfaces',
  );

  assert.equal(
    (
      await request(`/api/books/${ids[62]}/status`, reader.cookie, 'POST', {
        tbrRank: 1,
      })
    ).status,
    200,
  );
  assert.equal((await queue()).books[0].id, ids[62]);
  const before = (await queue()).books.map((book) => [book.id, book.rank]);
  await db.execute(
    "CREATE TRIGGER tbr_fail_rank BEFORE UPDATE OF tbr_rank ON user_book_status WHEN NEW.tbr_rank=2 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  assert.equal(
    (
      await request(`/api/books/${ids[20]}/status`, reader.cookie, 'POST', {
        tbrRank: 1,
      })
    ).status,
    500,
  );
  assert.deepEqual(
    (await queue()).books.map((book) => [book.id, book.rank]),
    before,
  );
  await db.execute('DROP TRIGGER tbr_fail_rank');
  assert.equal(
    (
      await request(`/api/books/${ids[1]}/status`, reader.cookie, 'POST', {
        status: 'reading',
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(notePath, reader.cookie)).data.data.rationale,
    'Reader reason',
  );
  await request(`/api/books/${ids[1]}/status`, reader.cookie, 'POST', {
    status: 'to_be_read',
  });
  assert.equal((await queue()).books.at(-1).id, ids[1]);
  console.log(
    'PASS long-distance rank edits, transaction rollback and status-independent rationale',
  );

  const beforeRestriction = (await queue()).books.map((book) => [
    book.id,
    book.rank,
  ]);
  await setTagRules(owner, reader, { blockTagIds: ['tbr-hidden'] });
  assert.deepEqual(
    (await queue()).books.map((book) => [book.id, book.rank]),
    beforeRestriction.filter(([id]) => id === ids[0]),
  );
  assert.equal((await request(notePath, reader.cookie)).status, 404);
  const restricted = await request('/api/dashboard', reader.cookie);
  assert.equal(restricted.data.data.counts.total, 1);
  assert.equal(restricted.data.data.counts.to_be_read, 1);
  assert.equal(
    (await request(notePath, reader.cookie, 'PUT', { rationale: 'Blocked' }))
      .status,
    404,
  );
  await setTagRules(owner, reader);
  assert.equal((await queue()).count, 63);
  assert.deepEqual(
    (await queue()).books.map((book) => [book.id, book.rank]),
    beforeRestriction,
  );
  assert.equal(
    (await request(notePath, reader.cookie)).data.data.rationale,
    'Reader reason',
  );
  assert.deepEqual(
    (await queue()).books.map((book) => book.rank),
    Array.from({ length: 63 }, (_, i) => i + 1),
  );
  await request(notePath, reader.cookie, 'PUT', { rationale: '' });
  assert.equal(
    (await request(notePath, reader.cookie)).data.data.rationale,
    '',
  );
  console.log(
    'PASS revocation/restoration, visible books, contiguous ranks and retained/cleared rationale',
  );
} finally {
  db.close();
}
