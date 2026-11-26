import assert from 'node:assert/strict';
import {
  account,
  expectStatus,
  json,
  request,
  rulesPath,
  setRole,
  setTagRules,
  tagBook,
} from './library-fixtures.mjs';
import { pdfFixture } from './pdf-fixture.mjs';

const owner = await account('owner');
const reader = await account('reader');
const admin = await account('admin');
assert.equal(owner.role, 'owner');
assert.equal(reader.role, 'reader');
assert.equal(admin.role, 'reader');
await setRole(owner, admin, 'admin');

const created = await json(
  await request(admin, '/api/auth/admin/create-user', 'POST', {
    email: 'admin-created@example.invalid',
    name: 'Admin created',
  }),
);
assert.equal(created.user.role, 'reader');

async function createBook(actor, label) {
  const { data } = await json(
    await request(actor, '/api/books', 'POST', {
      title: `Library fixture ${label}`,
      authors: [`Fixture author ${label}`],
      pages: 100,
    }),
  );
  return data.book.id;
}

const allowed = await createBook(owner, 'Allowed');
const blocked = await createBook(owner, 'Blocked');
const untagged = await createBook(owner, 'Untagged');
const allowTag = await tagBook(owner, allowed, 'Allowed label');
await tagBook(owner, blocked, allowTag.name);
const blockTag = await tagBook(owner, blocked, 'Blocked label');
const mergeTarget = await tagBook(owner, blocked, 'Replacement label');

const bookPath = `/api/books/${allowed}`;
const upload = new FormData();
upload.append(
  'files',
  new Blob([pdfFixture()], { type: 'application/pdf' }),
  'Role fixture.pdf',
);
for (const [path, method, body] of [
  ['/api/books', 'POST', { title: 'Denied', authors: ['Fixture author'] }],
  [bookPath, 'PUT', { title: 'Denied' }],
  [bookPath, 'DELETE'],
  ['/api/books/upload', 'POST', upload],
  [
    '/api/books/metadata-import/create',
    'POST',
    { title: 'Denied', authors: ['Fixture author'] },
  ],
  ['/api/books/bulk/copies', 'POST', { bookIds: [allowed], physical: true }],
]) {
  await expectStatus(await request(reader, path, method, body), 403);
}

await expectStatus(
  await request(reader, `${bookPath}/status`, 'POST', { status: 'finished' }),
);
await expectStatus(
  await request(reader, `${bookPath}/rating`, 'POST', { rating: 4 }),
);
await expectStatus(
  await request(reader, `${bookPath}/reading-position`, 'PUT', {
    location: 'synthetic-location',
    progress: 100,
  }),
);
for (const actor of [reader, owner]) {
  const { data } = await json(await request(actor, `${bookPath}/status`));
  assert.equal(data.status, actor === reader ? 'finished' : null);
}

await expectStatus(
  await request(reader, '/api/auth/admin/set-role', 'POST', {
    userId: reader.id,
    role: 'editor',
  }),
  403,
);
await expectStatus(
  await request(admin, '/api/auth/admin/set-role', 'POST', {
    userId: reader.id,
    role: 'user',
  }),
  400,
);
await setRole(admin, reader, 'editor');
const editable = await createBook(reader, 'Editor');
await expectStatus(
  await request(reader, `/api/books/${editable}`, 'PUT', { pages: 125 }),
);
await expectStatus(
  await request(reader, '/api/books/bulk/copies', 'POST', {
    bookIds: [editable],
    physical: true,
  }),
);
const edited = await json(await request(owner, `/api/books/${editable}`));
assert.equal(edited.data.book.pages, 125);
assert.equal(edited.data.book.hasPhysicalCopy, true);
await expectStatus(await request(reader, `/api/books/${editable}`, 'DELETE'));
await setRole(admin, reader, 'reader');
console.log(
  'PASS account roles, reader catalog restrictions, private reading data, and editor catalog writes',
);

const rulePath = rulesPath(reader.id);
const readRules = async (actor) => {
  const response = await json(await request(actor, rulePath));
  assert.equal(response.success, true);
  return response.data;
};
const emptyRules = { userId: reader.id, allowTags: [], blockTags: [] };
assert.deepEqual(await readRules(admin), emptyRules);
for (const method of ['GET', 'PUT']) {
  const body =
    method === 'PUT'
      ? { allowTagIds: [], blockTagIds: [blockTag.id] }
      : undefined;
  await expectStatus(await request(reader, rulePath, method, body), 403);
  await expectStatus(
    await request(admin, rulesPath('missing-user'), method, body),
    404,
  );
}
for (const body of [
  { allowTagIds: [allowTag.id], blockTagIds: [allowTag.id] },
  { allowTagIds: ['missing-tag'], blockTagIds: [] },
  { allowTagIds: [], blockTagIds: ['missing-tag'] },
]) {
  await expectStatus(await request(admin, rulePath, 'PUT', body), 400);
}
for (const target of [owner, admin]) {
  await expectStatus(
    await request(owner, rulesPath(target.id), 'PUT', {
      allowTagIds: [allowTag.id],
      blockTagIds: [],
    }),
    409,
  );
}
assert.deepEqual(await readRules(admin), emptyRules);

const all = [allowed, blocked, untagged];
async function assertVisibility(actor, visible, authors, tags) {
  for (const [path, items] of [
    ['/api/books', (data) => data.books],
    ['/api/search?q=Library%20fixture', (data) => data.buckets.books],
  ]) {
    const { data } = await json(await request(actor, path));
    assert.deepEqual(
      new Set(items(data).map((book) => book.id)),
      new Set(visible),
      path,
    );
  }
  const overview = (await json(await request(actor, '/api/dashboard/overview')))
    .data;
  assert.equal(overview.counts.total, visible.length);
  assert.deepEqual(
    new Set(overview.recent.map((book) => book.id)),
    new Set(visible),
  );
  for (const [entity, names] of [
    ['authors', authors],
    ['tags', tags],
  ]) {
    const { data } = await json(await request(actor, `/api/${entity}`));
    assert.deepEqual(
      new Set(data[entity].map((entry) => entry.name)),
      new Set(names),
    );
  }
  for (const book of all) {
    const status = visible.includes(book) ? 200 : 404;
    for (const suffix of ['', '/finish-summary']) {
      await expectStatus(
        await request(actor, `/api/books/${book}${suffix}`),
        status,
      );
    }
  }
}
const blockRules = { ...emptyRules, blockTags: [blockTag] };
assert.deepEqual(
  await setTagRules(admin, reader, { blockTagIds: [blockTag.id] }),
  blockRules,
);
assert.deepEqual(await readRules(admin), blockRules);
await assertVisibility(
  reader,
  [allowed, untagged],
  ['Fixture author Allowed', 'Fixture author Untagged'],
  [allowTag.name],
);
const combined = { allowTagIds: [allowTag.id], blockTagIds: [blockTag.id] };
assert.deepEqual(await setTagRules(admin, reader, combined), {
  ...blockRules,
  allowTags: [allowTag],
});
await assertVisibility(
  reader,
  [allowed],
  ['Fixture author Allowed'],
  [allowTag.name],
);
for (const actor of [owner, admin]) {
  await assertVisibility(
    actor,
    all,
    [
      'Fixture author Allowed',
      'Fixture author Blocked',
      'Fixture author Untagged',
    ],
    [allowTag.name, blockTag.name, mergeTarget.name],
  );
}
await expectStatus(
  await request(admin, `/api/tags/${blockTag.id}`, 'DELETE'),
  409,
);
await expectStatus(
  await request(admin, `/api/tags/${blockTag.id}/merge`, 'POST', {
    targetId: mergeTarget.id,
  }),
);
assert.deepEqual(await readRules(admin), {
  ...blockRules,
  allowTags: [allowTag],
  blockTags: [mergeTarget],
});
await expectStatus(await request(reader, `/api/books/${blocked}`), 404);
assert.deepEqual(await setTagRules(admin, reader), emptyRules);
await assertVisibility(
  reader,
  all,
  [
    'Fixture author Allowed',
    'Fixture author Blocked',
    'Fixture author Untagged',
  ],
  [allowTag.name, mergeTarget.name],
);
console.log(
  'PASS tag-rule authorization, validation, visibility across read surfaces, and tag merge protection',
);

for (const [path, method] of [
  ['/api/collections', 'GET'],
  ['/api/collections', 'POST'],
  ['/api/collections/retired/bookshelf', 'GET'],
  [`${bookPath}/collections`, 'GET'],
  [`${bookPath}/collections`, 'PUT'],
  ['/api/books/move', 'POST'],
  ['/api/books/collection-sources', 'POST'],
  ['/api/settings/admin/collections', 'GET'],
  ['/api/settings/admin/collections/default', 'PUT'],
  ['/api/settings/admin/collections-migration', 'GET'],
]) {
  await expectStatus(await request(owner, path, method), 404);
}
console.log('PASS retired collection endpoints return 404');
