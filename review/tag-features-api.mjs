import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { fetchAuth } from './fetch-auth.mjs';

const base = 'http://127.0.0.1:4317';
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
const results = [];
function pass(check) {
  results.push(check);
  console.log('PASS', check);
}
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
  const email = `tags-${name}-${randomBytes(5).toString('hex')}@example.invalid`;
  const password = randomBytes(20).toString('hex');
  const response = await fetchAuth(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Tag test ' + name, email, password }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const json = await response.json();
  return {
    id: json.user.id,
    email,
    password,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
  };
}
const owner = await signup('owner');
const member = await signup('member');
const admin = await signup('admin');
await db.execute({
  sql: "UPDATE users SET role = 'admin' WHERE id = ?",
  args: [admin.id],
});
const collection = async (user) =>
  (
    await db.execute({
      sql: 'SELECT id FROM collections WHERE owner_user_id = ? AND is_personal = 1',
      args: [user.id],
    })
  ).rows[0].id;
const ownerCollection = await collection(owner);
const memberCollection = await collection(member);
await db.execute({
  sql: "INSERT INTO collection_members (collection_id,user_id,role,created_at) VALUES (?,?,'viewer',?)",
  args: [ownerCollection, admin.id, 1700000000],
});
const tag = async (id, name) =>
  db.execute({
    sql: 'INSERT INTO tags(id,name,created_at,updated_at) VALUES(?,?,?,?)',
    args: [id, name, 1700000000, 1700000000],
  });
const link = async (book, id) =>
  db.execute({
    sql: 'INSERT INTO book_tags(book_id,tag_id) VALUES(?,?)',
    args: [book, id],
  });
await tag('tag-sort', 'Sorting fixture');
const keys = ['delta', 'alpha', 'alpha', 'zeta', 'beta', 'gamma', 'beta'];
const pages = [100, null, 0, 100, 200, -1, 50];
const published = [20, null, 10, 20, 30, null, 10];
for (let i = 0; i < keys.length; i++) {
  const id = `tag-book-${i + 1}`;
  await db.execute({
    sql: 'INSERT INTO books(id,title,sort_title,pages,published_at,created_at,updated_at,created_by_user_id) VALUES(?,?,?,?,?,?,?,?)',
    args: [
      id,
      `Fixture ${i + 1} ${keys[i]}`,
      keys[i],
      pages[i],
      published[i],
      1700000000 + Math.floor(i / 2) * 100,
      1700000000,
      owner.id,
    ],
  });
  await db.execute({
    sql: 'INSERT INTO collection_books(collection_id,book_id,added_at) VALUES(?,?,?)',
    args: [ownerCollection, id, 1700000000],
  });
  await link(id, 'tag-sort');
}
await db.execute({
  sql: "INSERT INTO collections(id,name,owner_user_id,is_personal,created_at,updated_at) VALUES('tag-extra-collection','Duplicate membership',?,0,?,?)",
  args: [owner.id, 1700000000, 1700000000],
});
await db.execute({
  sql: "INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES('tag-extra-collection',?,'owner',?)",
  args: [owner.id, 1700000000],
});
await db.execute(
  "INSERT INTO collection_books(collection_id,book_id,added_at) VALUES('tag-extra-collection','tag-book-1',1700000000)",
);
await db.execute({
  sql: "INSERT INTO books(id,title,sort_title,created_at,updated_at,created_by_user_id) VALUES('tag-hidden-book','Hidden fixture','hidden',1700000000,1700000000,?)",
  args: [member.id],
});
await db.execute({
  sql: "INSERT INTO collection_books(collection_id,book_id,added_at) VALUES(?,'tag-hidden-book',1700000000)",
  args: [memberCollection],
});
await db.execute(
  "INSERT INTO authors(id,name,created_at,updated_at) VALUES('sort-author','Sorting author',1700000000,1700000000),('hidden-author','Hidden author',1700000000,1700000000)",
);
await db.execute(
  "INSERT INTO publishers(id,name,created_at,updated_at) VALUES('sort-publisher','Sorting publisher',1700000000,1700000000),('hidden-publisher','Hidden publisher',1700000000,1700000000)",
);
await db.execute(
  "INSERT INTO book_authors(book_id,author_id,position) SELECT id,'sort-author',0 FROM books",
);
await db.execute(
  "INSERT INTO book_authors(book_id,author_id,position) VALUES('tag-hidden-book','hidden-author',1)",
);
await db.execute("UPDATE books SET publisher_id='sort-publisher'");
const expected = {
  dateAdded: { asc: [1, 2, 3, 4, 5, 6, 7], desc: [7, 6, 5, 4, 3, 2, 1] },
  alphabetical: { asc: [2, 3, 5, 7, 1, 6, 4], desc: [4, 6, 1, 7, 5, 3, 2] },
  publishedDate: { asc: [2, 6, 3, 7, 1, 4, 5], desc: [5, 4, 1, 7, 3, 6, 2] },
  pages: { asc: [3, 7, 1, 4, 5, 2, 6], desc: [5, 4, 1, 7, 3, 6, 2] },
};
for (const endpoint of [
  '/api/books',
  '/api/tags/tag-sort/books',
  '/api/authors/sort-author/books',
  '/api/publishers/sort-publisher/books',
]) {
  for (const [sort, directions] of Object.entries(expected)) {
    for (const [sortDir, order] of Object.entries(directions)) {
      let cursor;
      const found = [];
      do {
        const query = new URLSearchParams({
          sort,
          sortDir,
          limit: '2',
          ...(cursor ? { cursor } : {}),
        });
        const response = await request(`${endpoint}?${query}`, owner.cookie);
        assert.equal(response.status, 200, JSON.stringify(response.data));
        found.push(...response.data.data.books.map((b) => b.id));
        cursor = response.data.data.nextCursor;
        assert.ok(
          found.length <= 7,
          'pagination terminates without duplicate rows',
        );
      } while (cursor);
      assert.deepEqual(
        found,
        order.map((n) => `tag-book-${n}`),
        `${endpoint} ${sort} ${sortDir}`,
      );
      pass(
        `${endpoint} ${sort} ${sortDir} traverses ties and unknowns across pages`,
      );
    }
  }
}
for (const kind of ['authors', 'publishers']) {
  const id = kind === 'authors' ? 'sort-author' : 'sort-publisher';
  const hidden = kind === 'authors' ? 'hidden-author' : 'hidden-publisher';
  assert.equal(
    (await request(`/api/${kind}/${hidden}/books`, owner.cookie)).status,
    404,
  );
  const scoped = await request(
    `/api/${kind}/${id}/books?collectionId=${memberCollection}&sort=pages&sortDir=asc`,
    owner.cookie,
  );
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.data.data.books, []);
  const visible = await request(
    `/api/${kind}/${id}/books?limit=200&sort=alphabetical&sortDir=asc`,
    member.cookie,
  );
  assert.equal(visible.status, 200);
  assert.deepEqual(
    visible.data.data.books.map((book) => book.id),
    ['tag-hidden-book'],
  );
  pass(`${kind} sorting preserves entity visibility and collection membership`);
}
const oldCursor = Buffer.from(
  JSON.stringify({
    createdAt: new Date(1700000200000).toISOString(),
    id: 'tag-book-6',
  }),
).toString('base64url');
assert.equal(
  (await request(`/api/tags/tag-sort/books?cursor=${oldCursor}`, owner.cookie))
    .status,
  200,
);
pass('legacy tag cursor does not crash the endpoint');
await tag('tag-source', 'Garbage tag');
await tag('tag-target', 'Clean tag');
await tag('tag-hidden', 'Hidden tag');
await tag('tag-delete', 'Delete fixture');
for (const id of ['tag-source', 'tag-target', 'tag-delete'])
  await link('tag-book-1', id);
await link('tag-book-2', 'tag-source');
for (const id of ['tag-source', 'tag-hidden', 'tag-delete'])
  await link('tag-hidden-book', id);
for (const [cookie, status, label] of [
  [undefined, 401, 'guest'],
  [member.cookie, 403, 'ordinary user'],
]) {
  assert.equal(
    (await request('/api/tags/tag-source', cookie, 'DELETE')).status,
    status,
  );
  assert.equal(
    (
      await request('/api/tags/tag-source/merge', cookie, 'POST', {
        targetId: 'tag-target',
      })
    ).status,
    status,
  );
  pass(`${label} cannot delete or merge tags`);
}
for (const [source, body, status] of [
  ['tag-source', { targetId: 'tag-source' }, 400],
  ['tag-source', {}, 400],
  ['tag-source', { targetId: 17 }, 400],
  ['tag-source', null, 400],
  ['tag-source', { targetId: 'tag-hidden' }, 404],
  ['tag-hidden', { targetId: 'tag-target' }, 404],
  ['tag-source', { targetId: 'missing-tag' }, 404],
]) {
  assert.equal(
    (await request(`/api/tags/${source}/merge`, owner.cookie, 'POST', body))
      .status,
    status,
    JSON.stringify(body),
  );
}
pass(
  'self merge, malformed bodies, missing tags and invisible tags are rejected',
);
for (const [id, name] of [
  ['tag-percent', '%'],
  ['tag-underscore', '_'],
  ['tag-backslash', '\\'],
]) {
  await tag(id, name);
  await link('tag-book-1', id);
  const response = await request(
    '/api/tags/search?q=' + encodeURIComponent(name),
    owner.cookie,
  );
  assert.equal(response.status, 200);
  assert.ok(
    response.data.data.results.some((result) => result.id === id),
    'literal destination ' + name,
  );
}
pass(
  'merge destination search treats percent, underscore and backslash literally',
);
const merged = await request(
  '/api/tags/tag-source/merge',
  admin.cookie,
  'POST',
  { targetId: 'tag-target' },
);
assert.equal(merged.status, 200, JSON.stringify(merged.data));
assert.equal(
  (await db.execute("SELECT count(*) AS n FROM tags WHERE id='tag-source'"))
    .rows[0].n,
  0,
);
assert.deepEqual(
  (
    await db.execute(
      "SELECT book_id FROM book_tags WHERE tag_id='tag-target' ORDER BY book_id",
    )
  ).rows.map((r) => r.book_id),
  ['tag-book-1', 'tag-book-2', 'tag-hidden-book'],
);
assert.equal(
  (
    await db.execute(
      "SELECT count(*) AS n FROM book_tags WHERE tag_id='tag-source'",
    )
  ).rows[0].n,
  0,
);
pass(
  'admin merge moves all books including hidden books, deduplicates overlap and removes source',
);
assert.equal(
  (
    await request('/api/tags/tag-source/merge', owner.cookie, 'POST', {
      targetId: 'tag-target',
    })
  ).status,
  404,
);
assert.equal(
  (await request('/api/tags/tag-delete', owner.cookie, 'DELETE')).status,
  200,
);
assert.equal(
  (
    await db.execute(
      "SELECT count(*) AS n FROM book_tags WHERE tag_id='tag-delete'",
    )
  ).rows[0].n,
  0,
);
assert.equal(
  (await db.execute('SELECT count(*) AS n FROM books')).rows[0].n,
  8,
);
assert.equal(
  (await request('/api/tags/tag-delete', owner.cookie, 'DELETE')).status,
  404,
);
pass(
  'owner deletion removes all tag links, preserves every book and rejects a stale repeat',
);
for (const [id, name] of [
  ['tag-browser-merge', 'Browser merge source'],
  ['tag-browser-target', 'Browser merge target'],
  ['tag-browser-delete', 'Browser delete fixture'],
]) {
  await tag(id, name);
  await link('tag-book-1', id);
}
await mkdir('.audit', { recursive: true });
await writeFile(
  '.audit/tag-browser-account.json',
  JSON.stringify({ owner, member, admin, ownerCollection }),
);
await writeFile(
  '.audit/tag-api-results.json',
  JSON.stringify(results, null, 2),
);
db.close();
console.log(`PASS ${results.length} tag API checks`);
