import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:4317';
const records = [];
function record(name, evidence) {
  records.push({ name, evidence });
  console.log(name, JSON.stringify(evidence));
}
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
  const email = `audit-${label}@example.invalid`;
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
assert.ok(JSON.stringify(leak.data).includes('PrivateUniqueAuditAuthor'));
record('CONFIRMED private entity search leak', {
  foreignBookAccessBefore: before.status,
  buckets: leak.data.data.buckets,
});
const assign = await request(
  `/api/collections/${bCollection}/books/bulk`,
  b.cookie,
  'POST',
  { bookIds: [aBook], addToCollectionIds: [bCollection] },
);
const after = await request('/api/books/' + aBook, b.cookie);
assert.equal(assign.status, 200);
assert.equal(after.status, 200);
record('CONFIRMED explicit bulk assignment grants foreign book access', {
  before: before.status,
  assignment: assign.status,
  after: after.status,
});
const c = await signup('c');
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
  c.cookie,
  'POST',
  meta,
);
assert.equal(duplicate.status, 409);
assert.ok(JSON.stringify(duplicate.data).includes(aBook));
const resolve = await request(
  '/api/books/metadata-import/create',
  c.cookie,
  'POST',
  { ...meta, duplicateAction: 'use_existing', existingBookId: aBook },
);
const cAfter = await request('/api/books/' + aBook, c.cookie);
assert.equal(resolve.status, 200);
assert.equal(cAfter.status, 200);
record(
  'CONFIRMED duplicate resolution exposes and grants private book access',
  {
    duplicateStatus: duplicate.status,
    candidateExposed: true,
    resolution: resolve.status,
    accessAfter: cAfter.status,
  },
);
const addEditor = await request(
  `/api/collections/${aCollection}/members`,
  a.cookie,
  'PUT',
  { email: b.email, role: 'editor' },
);
assert.equal(addEditor.status, 200);
const demote = await request(
  `/api/collections/${aCollection}/members`,
  b.cookie,
  'PUT',
  { email: a.email, role: 'viewer' },
);
assert.equal(demote.status, 200);
const members = await request(
  `/api/collections/${aCollection}/members`,
  b.cookie,
);
record('CONFIRMED editor can demote collection owner', {
  demotion: demote.status,
  membership: members.data,
});
const rating = await request(`/api/books/${aBook}/rating`, a.cookie, 'POST', {
  rating: 1,
});
assert.equal(rating.status, 200);
assert.equal(rating.data.data.rating, 2);
record('CONFIRMED integer half-star rating doubled', {
  submitted: 1,
  persisted: rating.data.data.rating,
});
const create2 = await request('/api/books', a.cookie, 'POST', {
  title: 'Private Audit Title Two',
  authors: ['PrivateUniqueAuditAuthor'],
  published: '2021-01-01',
});
assert.equal(create2.status, 200);
const first = await request(
  '/api/books?sort=publishedDate&sortDir=asc&limit=1',
  a.cookie,
);
assert.equal(first.status, 200);
record('PAGINATION first page shape', first.data);
const firstData = first.data.data;
const nextCursor = firstData.nextCursor ?? firstData.cursor;
if (nextCursor) {
  const second = await request(
    '/api/books?sort=publishedDate&sortDir=asc&limit=1&cursor=' +
      encodeURIComponent(nextCursor),
    a.cookie,
  );
  record('CONFIRMED published-date cursor unit mismatch', {
    firstBooks: firstData.books.map((x) => ({
      id: x.id,
      publishedAt: x.publishedAt,
    })),
    cursor: nextCursor,
    nextStatus: second.status,
    nextBooks: second.data?.data?.books,
  });
  assert.equal(second.data.data.books.length, 0);
} else
  record('INCONCLUSIVE published cursor', { reason: 'No cursor in response' });
const edit = await request('/api/books/' + aBook, a.cookie, 'PUT', {
  title: 'Changed Despite Failed Edit',
  authors: ['DuplicateAuditAuthor', 'DuplicateAuditAuthor'],
});
const edited = await request('/api/books/' + aBook, a.cookie);
record('METADATA duplicate author partial update', {
  editStatus: edit.status,
  bookAfter: edited.data?.data?.book ?? edited.data,
});
await writeFile(
  'audit-http-results.json',
  JSON.stringify(records, null, 2) + '\n',
);
