import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';
import { fetchAuth } from './fetch-auth.mjs';
const base = 'http://127.0.0.1:4317';
const suffix = randomBytes(6).toString('hex');
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
async function account(name) {
  const email = `${name}-${suffix}@example.invalid`;
  const r = await fetchAuth(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      email,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return {
    email,
    id: (await r.json()).user.id,
    cookie: r.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
  };
}
async function request(actor, path, method = 'GET', body) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(actor ? { Cookie: actor.cookie } : {}),
      Origin: base,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok(r) {
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
try {
  const owner = await account('owner');
  const reader = await account('reader');
  const outsider = await account('outsider');
  assert.equal((await request(null, '/api/shelves')).status, 401);
  const first = (
    await ok(
      await request(owner, '/api/collections', 'POST', {
        name: `First ${suffix}`,
      }),
    )
  ).data.collection.id;
  const second = (
    await ok(
      await request(owner, '/api/collections', 'POST', {
        name: `Second ${suffix}`,
      }),
    )
  ).data.collection.id;
  await ok(
    await request(owner, `/api/collections/${first}/members`, 'PUT', {
      email: reader.email,
      role: 'viewer',
    }),
  );
  await ok(
    await request(owner, `/api/collections/${second}/members`, 'PUT', {
      email: reader.email,
      role: 'editor',
    }),
  );
  const one = (
    await ok(
      await request(owner, '/api/books', 'POST', {
        title: 'Synthetic One',
        authors: ['Unique Author'],
        collectionIds: [first],
      }),
    )
  ).data.book.id;
  const two = (
    await ok(
      await request(owner, '/api/books', 'POST', {
        title: 'Synthetic Two',
        authors: ['Other Author'],
        collectionIds: [second],
      }),
    )
  ).data.book.id;
  await db.execute({
    sql: 'INSERT INTO book_identifiers(book_id,type,value) VALUES (?,?,?)',
    args: [one, 'isbn', '978-1-23456-789-0'],
  });
  const byAuthor = await ok(
    await request(reader, '/api/books?search=Unique%20Author'),
  );
  assert.ok(byAuthor.data.books.some((b) => b.id === one));
  const byIsbn = await ok(
    await request(reader, '/api/books?search=9781234567890'),
  );
  assert.ok(byIsbn.data.books.some((b) => b.id === one));
  const shelf = (
    await ok(
      await request(reader, '/api/shelves', 'POST', { name: 'Favorites' }),
    )
  ).data.id;
  const path = `/api/shelves/${shelf}`;
  const bookShelves = `/api/books/${one}/shelves`;
  assert.equal((await request(null, bookShelves)).status, 401);
  assert.equal((await request(outsider, bookShelves)).status, 404);
  assert.deepEqual(await ok(await request(owner, bookShelves)), []);
  assert.deepEqual(await ok(await request(reader, bookShelves)), [
    { id: shelf, name: 'Favorites', containsBook: false },
  ]);
  assert.equal((await request(outsider, path)).status, 404);
  assert.equal(
    (await request(outsider, `/api/books?shelfId=${shelf}`)).status,
    404,
  );
  await ok(
    await request(reader, `${path}/books`, 'POST', {
      action: 'add',
      bookIds: [one, two, one],
    }),
  );
  assert.deepEqual(await ok(await request(reader, bookShelves)), [
    { id: shelf, name: 'Favorites', containsBook: true },
  ]);
  await ok(
    await request(reader, `${path}/books`, 'POST', {
      action: 'remove',
      bookIds: [one],
    }),
  );
  assert.equal(
    (await ok(await request(reader, bookShelves)))[0].containsBook,
    false,
  );
  await ok(
    await request(reader, `${path}/books`, 'POST', {
      action: 'add',
      bookIds: [one],
    }),
  );
  let state = await ok(await request(reader, path));
  assert.deepEqual(new Set(state.books.map((b) => b.id)), new Set([one, two]));
  assert.equal(state.books.find((b) => b.id === one).canResize, false);
  assert.equal(state.books.find((b) => b.id === two).canResize, true);
  const originalPlacement = state.arrangement.bookcases
    .flatMap((c) => c.shelves.flatMap((s) => s.items))
    .find((i) => i.books.some((b) => b.id === one)).x;
  const wrong = structuredClone(state.arrangement);
  const protectedBook = wrong.bookcases
    .flatMap((c) => c.shelves.flatMap((s) => s.items.flatMap((i) => i.books)))
    .find((b) => b.id === one);
  protectedBook.height =
    protectedBook.height === 230 ? 229 : protectedBook.height + 1;
  assert.equal(
    (
      await request(reader, path, 'PUT', {
        revision: state.revision,
        token: state.token,
        arrangement: wrong,
      })
    ).status,
    403,
  );
  const stale = state;
  await ok(
    await request(
      owner,
      `/api/collections/${first}/members/${reader.id}`,
      'DELETE',
    ),
  );
  assert.equal((await request(reader, bookShelves)).status, 404);
  state = await ok(await request(reader, path));
  assert.deepEqual(
    state.books.map((b) => b.id),
    [two],
  );
  assert.ok(!JSON.stringify(state).includes(one));
  assert.equal(
    (
      await request(reader, path, 'PUT', {
        revision: stale.revision,
        token: stale.token,
        arrangement: stale.arrangement,
      })
    ).status,
    409,
  );
  await ok(
    await request(reader, path, 'PUT', {
      revision: state.revision,
      token: state.token,
      arrangement: state.arrangement,
    }),
  );
  await ok(
    await request(owner, `/api/collections/${first}/members`, 'PUT', {
      email: reader.email,
      role: 'viewer',
    }),
  );
  state = await ok(await request(reader, path));
  assert.equal(state.books.length, 2);
  assert.equal(
    state.arrangement.bookcases
      .flatMap((c) => c.shelves.flatMap((s) => s.items))
      .find((i) => i.books.some((b) => b.id === one)).x,
    originalPlacement,
  );
  const page = await ok(await request(reader, `/api/books?shelfId=${shelf}`));
  assert.equal(page.data.books.length, 2);
  const third = (
    await ok(
      await request(owner, '/api/books', 'POST', {
        title: 'Synthetic Three',
        authors: ['Other Author'],
        collectionIds: [second],
      }),
    )
  ).data.book.id;
  const sharedPath = `/api/collections/${second}/bookshelf`;
  const shared = await ok(await request(owner, sharedPath));
  const sharedItems = shared.arrangement.bookcases.flatMap((c) =>
    c.shelves.flatMap((s) => s.items),
  );
  const itemTwo = sharedItems.find((item) =>
    item.books.some((book) => book.id === two),
  );
  const itemThree = sharedItems.find((item) =>
    item.books.some((book) => book.id === third),
  );
  const firstRow = shared.arrangement.bookcases[0].shelves[0];
  for (const c of shared.arrangement.bookcases)
    for (const s of c.shelves) s.items = [];
  itemTwo.x = 2;
  itemThree.x = 34;
  firstRow.items = [itemTwo, itemThree];
  await ok(
    await request(owner, sharedPath, 'PUT', {
      revision: shared.revision,
      token: shared.token,
      arrangement: shared.arrangement,
    }),
  );
  state = await ok(await request(reader, path));
  const resized = state.arrangement.bookcases
    .flatMap((c) => c.shelves.flatMap((s) => s.items.flatMap((i) => i.books)))
    .find((book) => book.id === two);
  resized.width = 55;
  resized.manualWidth = true;
  state.arrangement.bookcases
    .flatMap((c) => c.shelves.flatMap((s) => s.items))
    .find((item) => item.books.some((book) => book.id === two)).x = 200;
  await ok(
    await request(reader, path, 'PUT', {
      revision: state.revision,
      token: state.token,
      arrangement: state.arrangement,
    }),
  );
  const repaired = await ok(await request(owner, sharedPath));
  const repairedItems = repaired.arrangement.bookcases.flatMap((c) =>
    c.shelves.flatMap((s) => s.items),
  );
  assert.equal(
    repairedItems.find((item) => item.books.some((book) => book.id === third))
      .x,
    34,
  );
  assert.equal(
    repairedItems.find((item) => item.books.some((book) => book.id === two))
      .books[0].width,
    55,
  );
  await ok(
    await request(reader, `${path}/books`, 'POST', {
      action: 'remove',
      bookIds: [one],
    }),
  );
  assert.deepEqual(
    (await ok(await request(reader, path))).books.map((b) => b.id),
    [two],
  );
  assert.equal((await request(reader, `/api/books/${one}`)).status, 200);
  await ok(await request(reader, path, 'DELETE'));
  assert.equal((await request(reader, path)).status, 404);
  console.log(
    'PASS personal Shelf privacy, cross-collection books, search, resize authority, revocation and restoration',
  );
} finally {
  db.close();
}
