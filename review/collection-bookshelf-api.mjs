import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createClient } from './sqlite-client.mjs';
import { fetchAuth } from './fetch-auth.mjs';

const base = (
  process.env.DELB_REVIEW_URL ||
  process.env.BASE_URL ||
  'http://127.0.0.1:4317'
).replace(/\/$/, '');
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const suffix = randomBytes(6).toString('hex');
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
async function account(name) {
  const email = `${name}-${suffix}@example.invalid`;
  const response = await fetchAuth(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      name,
      email,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return {
    email,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
async function request(path, actor, method = 'GET', body) {
  return fetch(base + path, {
    method,
    headers: {
      Cookie: actor.cookie,
      Origin: base,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
try {
  const owner = await account('shelf-owner');
  const viewer = await account('shelf-viewer');
  const outsider = await account('shelf-outsider');
  const created = await request('/api/collections', owner, 'POST', {
    name: `Shelf ${suffix}`,
  });
  assert.equal(created.status, 200, await created.clone().text());
  const id = (await created.json()).data.collection.id;
  const path = `/api/collections/${id}/bookshelf`;
  const member = await request(`/api/collections/${id}/members`, owner, 'PUT', {
    email: viewer.email,
    role: 'viewer',
  });
  assert.equal(member.status, 200, await member.clone().text());
  await db.execute({
    sql: 'INSERT INTO books(id,title,sort_title,pages,created_at,updated_at,collection_id) VALUES (?,?,?,?,1,1,?)',
    args: [
      `shelf-book-${suffix}`,
      'Shelf test book',
      'Shelf test book',
      250,
      id,
    ],
  });
  const precomputed = await db.execute({
    sql: 'SELECT width,height,source_pages FROM book_shelf_dimensions WHERE book_id=?',
    args: [`shelf-book-${suffix}`],
  });
  assert.equal(
    precomputed.rows.length,
    1,
    'Book creation stores spine dimensions before the shelf is opened',
  );
  assert.equal(precomputed.rows[0].source_pages, 250);
  await db.execute({
    sql: 'UPDATE books SET pages=? WHERE id=?',
    args: [900, `shelf-book-${suffix}`],
  });
  const initial = await request(path, owner);
  assert.equal(initial.status, 200, await initial.clone().text());
  const snapshot = await initial.json();
  const legacySave = await request('/api/bookshelf', owner, 'PUT', {
    revision: 0,
    arrangement: snapshot.arrangement,
  });
  assert.equal(legacySave.status, 200);
  const legacy = await (await request('/api/bookshelf', owner)).json();
  assert.equal(snapshot.books.length, 1);
  assert.equal(snapshot.canEdit, true);
  const matchesResponse = await request(
    `/api/books?idsOnly=1&collectionId=${encodeURIComponent(id)}&title=Shelf%20test%20book&limit=20000`,
    viewer,
  );
  assert.equal(matchesResponse.status, 200);
  assert.deepEqual((await matchesResponse.json()).data.books, [
    { id: `shelf-book-${suffix}` },
  ]);
  const hiddenMatches = await request(
    `/api/books?idsOnly=1&collectionId=${encodeURIComponent(id)}&limit=20000`,
    outsider,
  );
  assert.deepEqual((await hiddenMatches.json()).data.books, []);
  assert.equal(
    snapshot.arrangement.bookcases.flatMap((c) =>
      c.shelves.flatMap((s) => s.items.flatMap((i) => i.books)),
    ).length,
    1,
  );
  const initialBook = snapshot.arrangement.bookcases.flatMap((c) =>
    c.shelves.flatMap((s) => s.items.flatMap((i) => i.books)),
  )[0];
  assert.equal(initialBook.width, 55);
  assert.equal(initialBook.sourcePages, 900);
  const readViewer = await request(path, viewer);
  assert.equal(readViewer.status, 200);
  assert.equal((await readViewer.json()).canEdit, false);
  const beforeSave = await db.execute({
    sql: 'SELECT revision FROM collection_bookshelves WHERE collection_id=?',
    args: [id],
  });
  assert.equal(
    beforeSave.rows.length,
    0,
    'Opening a shelf does not save an arrangement',
  );
  assert.equal((await request(path, outsider)).status, 404);
  const payload = {
    revision: snapshot.revision,
    token: snapshot.token,
    arrangement: snapshot.arrangement,
  };
  assert.equal((await request(path, viewer, 'PUT', payload)).status, 403);
  const saved = await request(path, owner, 'PUT', payload);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await request(path, owner, 'PUT', payload)).status, 409);
  const readAfter = await request(path, viewer);
  const after = await readAfter.json();
  assert.equal(after.revision, 1);
  assert.deepEqual(after.arrangement, snapshot.arrangement);
  const dim = await db.execute({
    sql: 'SELECT width,height,source_pages FROM book_shelf_dimensions WHERE book_id=?',
    args: [`shelf-book-${suffix}`],
  });
  assert.equal(dim.rows.length, 1);
  assert.equal(dim.rows[0].width, 55);
  assert.equal(dim.rows[0].source_pages, 900);
  const promoted = await request(
    `/api/collections/${id}/members`,
    owner,
    'PUT',
    { email: viewer.email, role: 'editor' },
  );
  assert.equal(promoted.status, 200);
  const current = await (await request(path, viewer)).json();
  assert.equal(current.canEdit, true);
  const nextPayload = {
    revision: current.revision,
    token: current.token,
    arrangement: current.arrangement,
  };
  const simultaneous = await Promise.all([
    request(path, owner, 'PUT', nextPayload),
    request(path, viewer, 'PUT', nextPayload),
  ]);
  assert.deepEqual(
    simultaneous.map((response) => response.status).sort(),
    [200, 409],
  );
  const beforeMove = await (await request(path, owner)).json();
  const targetResponse = await request('/api/collections', owner, 'POST', {
    name: `Destination ${suffix}`,
  });
  const targetId = (await targetResponse.json()).data.collection.id;
  const bookId = `shelf-book-${suffix}`;
  const moved = await request(
    `/api/books/${bookId}/collections`,
    owner,
    'PUT',
    { collectionId: targetId, sourceCollectionId: id, confirmed: true },
  );
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal(
    (
      await request(path, owner, 'PUT', {
        revision: beforeMove.revision,
        token: beforeMove.token,
        arrangement: beforeMove.arrangement,
      })
    ).status,
    409,
  );
  const source = await (await request(path, viewer)).json();
  assert.equal(source.books.length, 0);
  assert.equal(
    source.arrangement.bookcases.flatMap((c) =>
      c.shelves.flatMap((s) => s.items.flatMap((i) => i.books)),
    ).length,
    0,
  );
  const destination = await (
    await request(`/api/collections/${targetId}/bookshelf`, owner)
  ).json();
  const movedBook = destination.arrangement.bookcases.flatMap((c) =>
    c.shelves.flatMap((s) => s.items.flatMap((i) => i.books)),
  )[0];
  assert.equal(movedBook.id, bookId);
  assert.equal(movedBook.width, dim.rows[0].width);
  assert.equal(movedBook.height, dim.rows[0].height);
  const forged = structuredClone(source.arrangement);
  forged.bookcases[0].shelves[0].items.push({
    x: 2,
    horizontal: false,
    books: [movedBook],
  });
  assert.equal(
    (
      await request(path, viewer, 'PUT', {
        revision: source.revision,
        token: source.token,
        arrangement: forged,
      })
    ).status,
    409,
  );
  const revoked = await request(
    `/api/collections/${id}/members/${(await db.execute({ sql: 'SELECT id FROM users WHERE email=?', args: [viewer.email] })).rows[0].id}`,
    owner,
    'DELETE',
  );
  assert.equal(revoked.status, 200);
  assert.equal((await request(path, viewer)).status, 404);
  assert.equal(
    (
      await request(path, viewer, 'PUT', {
        revision: source.revision,
        token: source.token,
        arrangement: source.arrangement,
      })
    ).status,
    404,
  );
  assert.deepEqual(
    await (await request('/api/bookshelf', owner)).json(),
    legacy,
  );
  console.log(
    'PASS collection shelf sharing, permissions, revision conflict, and shared dimensions',
  );
} finally {
  db.close();
}
