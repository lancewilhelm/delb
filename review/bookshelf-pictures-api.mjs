import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from './test-image.mjs';
import { createClient } from './sqlite-client.mjs';
import { fetchAuth } from './fetch-auth.mjs';
const base = (
  process.env.DELB_REVIEW_URL ||
  process.env.BASE_URL ||
  'http://127.0.0.1:4317'
).replace(/\/$/, '');
const suffix = randomBytes(6).toString('hex');
async function account(name) {
  const email = `${name}-${suffix}@example.invalid`;
  const response = await fetchAuth(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
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
async function request(actor, path, method = 'GET', body) {
  return fetch(base + path, {
    method,
    headers: {
      ...(actor ? { Cookie: actor.cookie } : {}),
      Origin: base,
      ...(body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined
      ? {}
      : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
}
async function ok(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function upload(actor, path, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'test.png');
  return request(actor, path, 'POST', form);
}
const owner = await account('owner');
const viewer = await account('viewer');
const outsider = await account('outsider');
const first = (
  await ok(
    await request(owner, '/api/collections', 'POST', {
      name: `Pictures ${suffix}`,
    }),
  )
).data.collection.id;
const other = (
  await ok(
    await request(owner, '/api/collections', 'POST', {
      name: `Other ${suffix}`,
    }),
  )
).data.collection.id;
await ok(
  await request(owner, `/api/collections/${first}/members`, 'PUT', {
    email: viewer.email,
    role: 'viewer',
  }),
);
const collectionPath = `/api/collections/${first}/bookshelf`;
const picturesPath = `/api/bookshelf-pictures/collection/${first}`;
const image = await sharp({
  create: { width: 40, height: 20, channels: 4, background: '#c07534' },
})
  .png()
  .toBuffer();
assert.equal((await upload(viewer, picturesPath, image)).status, 403);
assert.equal((await upload(outsider, picturesPath, image)).status, 404);
assert.equal(
  (await upload(owner, picturesPath, Buffer.from('not an image'))).status,
  400,
);
const asset = await ok(await upload(owner, picturesPath, image));
assert.equal(
  (await request(viewer, `${picturesPath}?asset=${asset.id}`)).status,
  404,
);
let state = await ok(await request(owner, collectionPath));
state.arrangement.pictures.push({
  id: 'picture',
  assetId: asset.id,
  x: 5,
  y: 80,
  width: 80,
  height: 40,
  rotation: 30,
});
await ok(
  await request(owner, collectionPath, 'PUT', {
    revision: state.revision,
    token: state.token,
    arrangement: state.arrangement,
  }),
);
state = await ok(await request(owner, collectionPath));
assert.equal(state.arrangement.pictures[0].rotation, 30);
const served = await request(viewer, `${picturesPath}?asset=${asset.id}`);
assert.equal(served.status, 200);
assert.match(served.headers.get('content-type'), /^image\/webp/);
assert.equal(
  (await request(outsider, `${picturesPath}?asset=${asset.id}`)).status,
  404,
);
const wrong = await ok(
  await request(owner, `/api/collections/${other}/bookshelf`),
);
wrong.arrangement.pictures.push({
  id: 'wrong',
  assetId: asset.id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
});
assert.equal(
  (
    await request(owner, `/api/collections/${other}/bookshelf`, 'PUT', {
      revision: wrong.revision,
      token: wrong.token,
      arrangement: wrong.arrangement,
    })
  ).status,
  400,
);
const oldClient = structuredClone(state.arrangement);
delete oldClient.version;
delete oldClient.pictures;
assert.equal(
  (
    await request(owner, collectionPath, 'PUT', {
      revision: state.revision,
      token: state.token,
      arrangement: oldClient,
    })
  ).status,
  409,
);
const picture = state.arrangement.pictures[0];
state.arrangement.pictures = [];
await ok(
  await request(owner, collectionPath, 'PUT', {
    revision: state.revision,
    token: state.token,
    arrangement: state.arrangement,
  }),
);
assert.equal(
  (await request(viewer, `${picturesPath}?asset=${asset.id}`)).status,
  404,
);
assert.equal(
  (await request(owner, `${picturesPath}?asset=${asset.id}`)).status,
  200,
);
state = await ok(await request(owner, collectionPath));
state.arrangement.pictures.push(picture);
await ok(
  await request(owner, collectionPath, 'PUT', {
    revision: state.revision,
    token: state.token,
    arrangement: state.arrangement,
  }),
);
state = await ok(await request(owner, collectionPath));
state.arrangement.pictures = [];
await ok(
  await request(owner, collectionPath, 'PUT', {
    revision: state.revision,
    token: state.token,
    arrangement: state.arrangement,
  }),
);
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
await db.execute({
  sql: 'UPDATE shelf_picture_assets SET unused_since=? WHERE id=?',
  args: [Date.now() - 8 * 24 * 60 * 60 * 1000, asset.id],
});
db.close();
await ok(await upload(owner, picturesPath, image));
assert.equal(
  (await request(owner, `${picturesPath}?asset=${asset.id}`)).status,
  404,
);
const shelf = (
  await ok(await request(owner, '/api/shelves', 'POST', { name: 'Pictures' }))
).data.id;
const shelfPath = `/api/shelves/${shelf}`;
const personalPictures = `/api/bookshelf-pictures/personal/${shelf}`;
const personalAsset = await ok(await upload(owner, personalPictures, image));
let personal = await ok(await request(owner, shelfPath));
personal.arrangement.pictures.push({
  id: 'personal-picture',
  assetId: personalAsset.id,
  x: -20,
  y: 100,
  width: 200,
  height: 100,
  rotation: -15,
});
await ok(
  await request(owner, shelfPath, 'PUT', {
    revision: personal.revision,
    token: personal.token,
    arrangement: personal.arrangement,
  }),
);
personal = await ok(await request(owner, shelfPath));
assert.equal(personal.arrangement.pictures[0].x, -20);
assert.equal(
  (await request(viewer, `${personalPictures}?asset=${personalAsset.id}`))
    .status,
  404,
);
console.log(
  'PASS shelf picture upload, authorization, scope, revision fence, and reload',
);
