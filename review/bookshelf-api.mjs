import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fetchAuth } from './fetch-auth.mjs';
const base = 'http://127.0.0.1:4317';
async function account(name) {
  const response = await fetchAuth(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      email: `bookshelf-${name}@example.invalid`,
      name,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
}
async function request(cookie, method = 'GET', body) {
  return fetch(base + '/api/bookshelf', {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: base,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
assert.equal((await request('')).status, 401);
const suffix = randomBytes(6).toString('hex');
const a = await account(`${suffix}-a`),
  b = await account(`${suffix}-b`);
const initial = await request(a);
assert.deepEqual(await initial.json(), { revision: 0, arrangement: null });
const arrangement = {
  bookcases: [
    {
      id: 'case',
      width: 480,
      shelves: [{ id: 'shelf', height: 245, items: [] }],
    },
  ],
};
let response = await request(a, 'PUT', { revision: 0, arrangement });
assert.equal(response.status, 200, await response.clone().text());
assert.equal((await response.json()).revision, 1);
assert.equal(
  (await request(a, 'PUT', { revision: 0, arrangement })).status,
  409,
);
assert.deepEqual(await (await request(b)).json(), {
  revision: 0,
  arrangement: null,
});
assert.equal(
  (await request(a, 'PUT', { revision: 1, arrangement: { bookcases: [] } }))
    .status,
  400,
);
const tooNarrow = structuredClone(arrangement);
tooNarrow.bookcases[0].width = 20;
assert.equal(
  (await request(a, 'PUT', { revision: 1, arrangement: tooNarrow })).status,
  400,
);
const results = await Promise.all([
  request(a, 'PUT', { revision: 1, arrangement }),
  request(a, 'PUT', { revision: 1, arrangement }),
]);
assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
const saved = await (await request(a)).json();
assert.equal(saved.revision, 2);
assert.deepEqual(saved.arrangement, arrangement);
arrangement.bookcases[0].shelves.push({
  id: 'empty-shelf',
  height: 245,
  items: [],
});
response = await request(a, 'PUT', { revision: 2, arrangement });
assert.equal(response.status, 200, await response.clone().text());
arrangement.bookcases[0].shelves.pop();
response = await request(a, 'PUT', { revision: 3, arrangement });
assert.equal(response.status, 200, await response.clone().text());
const afterRemoval = await (await request(a)).json();
assert.equal(afterRemoval.revision, 4);
assert.deepEqual(afterRemoval.arrangement, arrangement);
arrangement.bookcases.push({
  id: 'second-case',
  width: 340,
  shelves: [{ id: 'second-shelf', height: 245, items: [] }],
});
response = await request(a, 'PUT', { revision: 4, arrangement });
assert.equal(response.status, 200, await response.clone().text());
arrangement.bookcases.reverse();
response = await request(a, 'PUT', { revision: 5, arrangement });
assert.equal(response.status, 200, await response.clone().text());
const reordered = await (await request(a)).json();
assert.equal(reordered.revision, 6);
assert.deepEqual(reordered.arrangement, arrangement);
response = await fetch(base + '/api/bookshelf', {
  method: 'PUT',
  headers: { Cookie: a, Origin: base, 'Content-Type': 'application/json' },
  body: ' '.repeat(16 * 1024 * 1024) + '{}',
});
assert.equal(response.status, 413);
assert.deepEqual(await (await request(a)).json(), reordered);
console.log(
  'Authenticated API passed: private reader state, persistence, shelf removal, bookcase order, request size, invalid geometry, stale revisions and concurrent writes.',
);
