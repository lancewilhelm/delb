import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from './test-image.mjs';
import { fetchAuth } from './fetch-auth.mjs';

const base = (
  process.env.DELB_REVIEW_URL ||
  process.env.BASE_URL ||
  'http://127.0.0.1:4317'
).replace(/\/$/, '');
const suffix = randomBytes(6).toString('hex');
async function signup(role) {
  const email = `spine-${role}-${suffix}@example.invalid`;
  const response = await fetchAuth(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: role,
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
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
async function request(path, account, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: base,
      ...(account ? { Cookie: account.cookie } : {}),
      ...(body && !(body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    ...(body
      ? { body: body instanceof FormData ? body : JSON.stringify(body) }
      : {}),
  });
  return response;
}
function upload(bytes, revision, edits, file = true) {
  const form = new FormData();
  if (file)
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'spine.png');
  form.append('revision', revision);
  form.append('edits', JSON.stringify(edits));
  return form;
}
const owner = await signup('owner'),
  editor = await signup('editor'),
  viewer = await signup('viewer'),
  outsider = await signup('outsider');
const createdCollection = await request('/api/collections', owner, 'POST', {
  name: `Spine fixture ${suffix}`,
});
assert.equal(
  createdCollection.status,
  200,
  await createdCollection.clone().text(),
);
const collection = (await createdCollection.json()).data.collection.id;
for (const [account, role] of [
  [editor, 'editor'],
  [viewer, 'viewer'],
]) {
  const response = await request(
    `/api/collections/${collection}/members`,
    owner,
    'PUT',
    { email: account.email, role },
  );
  assert.equal(response.status, 200, await response.clone().text());
}
const created = await request('/api/books', owner, 'POST', {
  title: 'Spine fixture',
  authors: ['Sample Author'],
  collectionIds: [collection],
});
assert.equal(created.status, 200, await created.clone().text());
const id = (await created.json()).data.book.id,
  path = `/api/books/${id}/spine`;
async function shelfRevision() {
  const response = await request(
    `/api/collections/${collection}/bookshelf`,
    viewer,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const shelf = await response.json();
  return shelf.books.find((book) => book.id === id).spineRevision;
}
assert.equal(await shelfRevision(), null);
const edits = { left: 0, right: 0, top: 0, bottom: 0, stretch: false };
const original = await sharp({
  create: { width: 60, height: 240, channels: 3, background: '#247e5b' },
})
  .png()
  .toBuffer();
assert.equal((await request(path, null)).status, 401);
assert.equal((await request(path, outsider)).status, 404);
assert.equal(
  (await request(path, viewer, 'POST', upload(original, '', edits))).status,
  403,
);
let response = await request(path, editor, 'POST', upload(original, '', edits));
assert.equal(response.status, 200, await response.clone().text());
let revision = (await response.json()).revision;
assert.equal(await shelfRevision(), revision);
assert.equal((await request(`${path}?variant=source`, viewer)).status, 403);
response = await request(`${path}?variant=source`, owner);
assert.equal(response.status, 200);
assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
response = await request(path, viewer);
assert.equal(response.status, 200);
assert.equal(response.headers.get('content-type'), 'image/webp');
const detail = await (await request(`/api/books/${id}`, viewer)).json();
assert.equal(detail.data.book.spineRevision, revision);
const list = await (
  await request(`/api/books?collectionId=${collection}`, viewer)
).json();
assert.equal(list.data.books.find((b) => b.id === id).spineRevision, revision);
assert.equal(
  (
    await request(
      path,
      owner,
      'POST',
      upload(Buffer.from('not an image'), revision, edits),
    )
  ).status,
  400,
);
assert.equal(
  (await request(path, owner, 'POST', upload(original, 'stale', edits))).status,
  409,
);
assert.equal(
  (await (await request(`${path}?variant=metadata`, viewer)).json()).revision,
  revision,
);
const crop = { ...edits, top: 25, stretch: true };
response = await request(
  path,
  editor,
  'POST',
  upload(original, revision, crop, false),
);
assert.equal(response.status, 200, await response.clone().text());
const previous = revision;
revision = (await response.json()).revision;
assert.notEqual(revision, previous);
assert.equal(await shelfRevision(), revision);
response = await request(path, viewer);
const metadata = await sharp(
  Buffer.from(await response.arrayBuffer()),
).metadata();
assert.equal(metadata.width, 256);
assert.equal(metadata.height, 768);
response = await request(`${path}?variant=source`, owner);
assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
const concurrent = await Promise.all([
  request(
    path,
    owner,
    'POST',
    upload(original, revision, { ...crop, left: 5 }, false),
  ),
  request(
    path,
    editor,
    'POST',
    upload(original, revision, { ...crop, right: 5 }, false),
  ),
]);
assert.deepEqual(concurrent.map((item) => item.status).sort(), [200, 409]);
revision = (await concurrent.find((item) => item.status === 200).json())
  .revision;
assert.equal((await request(path, viewer, 'DELETE', { revision })).status, 403);
assert.equal(
  (await request(path, owner, 'DELETE', { revision: previous })).status,
  409,
);
assert.equal((await request(path, owner, 'DELETE', { revision })).status, 200);
assert.equal(await shelfRevision(), null);
assert.equal((await request(path, viewer)).status, 404);
assert.equal(
  (await (await request(`${path}?variant=metadata`, viewer)).json()).exists,
  false,
);
assert.equal(
  (await (await request(`/api/books/${id}`, viewer)).json()).data.book
    .spineRevision,
  null,
);
console.log(
  'Spine API passed: visibility, editor permissions, upload, original retention, crop, stretch, stale writes and removal.',
);
