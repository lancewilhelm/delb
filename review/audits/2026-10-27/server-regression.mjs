import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const base = 'http://127.0.0.1:4317';
async function request(path, cookie, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data };
}
async function signup(label) {
  const email = `repair-${label}-${randomBytes(5).toString('hex')}@example.invalid`;
  const response = await fetch(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Audit ' + label,
      email,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  assert.ok(cookie);
  return { email, id: json.user.id, cookie };
}
const a = await signup('a'),
  b = await signup('b');
const createA = await request('/api/books', a.cookie, 'POST', {
  title: 'Private Audit Title One',
  authors: ['PrivateUniqueAuditAuthor'],
  tags: ['PrivateUniqueAuditTag'],
  published: '2020-01-01',
});
assert.equal(createA.status, 200, JSON.stringify(createA.data));
const aBook = createA.data.data.book.id;
const cA = await request('/api/collections', a.cookie, 'POST', {
    name: 'Audit A Shared',
  }),
  cB = await request('/api/collections', b.cookie, 'POST', {
    name: 'Audit B Collection',
  });
assert.equal(cA.status, 200);
assert.equal(cB.status, 200);
const aCollection = cA.data.data.collection.id,
  bCollection = cB.data.data.collection.id;
const before = await request('/api/books/' + aBook, b.cookie);
assert.ok([403, 404].includes(before.status));
const leak = await request('/api/search?q=PrivateUniqueAudit', b.cookie);
assert.equal(leak.status, 200);
assert.ok(!JSON.stringify(leak.data).includes('PrivateUniqueAuditAuthor'));
assert.ok(!JSON.stringify(leak.data).includes('PrivateUniqueAuditTag'));
const assign = await request(
  `/api/collections/${bCollection}/books/bulk`,
  b.cookie,
  'POST',
  { bookIds: [aBook], addToCollectionIds: [bCollection] },
);
assert.equal(assign.status, 404);
assert.equal((await request('/api/books/' + aBook, b.cookie)).status, 404);
assert.equal(
  (await request(`/api/books/${aBook}/rating`, b.cookie, 'POST', { rating: 1 }))
    .status,
  404,
);
for (let value = 1; value <= 10; value++) {
  const result = await request(`/api/books/${aBook}/rating`, a.cookie, 'POST', {
    rating: value,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.data.rating, value);
}
assert.equal(
  (
    await request(`/api/books/${aBook}/rating`, a.cookie, 'POST', {
      rating: 1.5,
    })
  ).status,
  400,
);
assert.equal(
  (
    await request(`/api/books/${aBook}/rating`, a.cookie, 'POST', {
      rating: null,
    })
  ).data.data.rating,
  null,
);
const meta = {
  provider: 'googleBooks',
  item: {
    id: 'audit-provider-one',
    volumeInfo: {
      title: 'Private Audit Title One',
      authors: ['PrivateUniqueAuditAuthor'],
    },
  },
};
const duplicate = await request(
  '/api/books/metadata-import/create',
  b.cookie,
  'POST',
  meta,
);
assert.notEqual(duplicate.status, 409);
const addMember = await request(
  `/api/collections/${aCollection}/members`,
  a.cookie,
  'PUT',
  { email: b.email, role: 'editor' },
);
assert.equal(addMember.status, 200, JSON.stringify(addMember.data));
const demote = await request(
  `/api/collections/${aCollection}/members`,
  b.cookie,
  'PUT',
  { email: a.email, role: 'viewer' },
);
assert.equal(demote.status, 400);
const linkToShared = await request(
  `/api/collections/${aCollection}/books/bulk`,
  a.cookie,
  'POST',
  { bookIds: [aBook], addToCollectionIds: [aCollection] },
);
assert.equal(linkToShared.status, 200);
const reshare = await request(
  `/api/collections/${bCollection}/books/bulk`,
  b.cookie,
  'POST',
  { bookIds: [aBook], addToCollectionIds: [bCollection] },
);
assert.equal(reshare.status, 200, JSON.stringify(reshare.data));
assert.equal((await request('/api/books/' + aBook, b.cookie)).status, 200);
const visibleSearch = await request(
  '/api/search?q=PrivateUniqueAudit',
  b.cookie,
);
assert.ok(
  JSON.stringify(visibleSearch.data).includes('PrivateUniqueAuditAuthor'),
);

console.log('Synthetic HTTP regression checks passed');
