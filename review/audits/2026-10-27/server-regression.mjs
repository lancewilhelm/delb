import { fetchAuth } from '../../fetch-auth.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
const base = 'http://127.0.0.1:4317';
async function request(path, cookie, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    signal: AbortSignal.timeout(20000),
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
  const response = await fetchAuth(base + '/api/auth/sign-up/email', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
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
const singleAssign = await request(
  `/api/books/${aBook}/collections`,
  b.cookie,
  'PUT',
  { addCollectionIds: [bCollection] },
);
assert.equal(singleAssign.status, 404);
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

const edited = await request(`/api/books/${aBook}`, a.cookie, 'PUT', {
  title: 'Edited Audit Book',
  authors: ['Repeated Writer', ' repeated writer '],
  tags: ['Repeated Tag', ' repeated tag '],
});
assert.equal(edited.status, 200, JSON.stringify(edited.data));
const editedBook = await request(`/api/books/${aBook}`, a.cookie);
assert.equal(editedBook.data.data.book.title, 'Edited Audit Book');
assert.equal(editedBook.data.data.authors.length, 1);
assert.equal(editedBook.data.data.tags.length, 1);
const imported = await request(
  '/api/books/metadata-import/create',
  b.cookie,
  'POST',
  {
    provider: 'googleBooks',
    item: {
      id: 'duplicates',
      volumeInfo: {
        title: 'Import With Duplicate Identifiers',
        authors: ['Import Writer', 'Import Writer'],
        industryIdentifiers: [
          { type: 'ISBN_13', identifier: '1234567890123' },
          { type: 'ISBN_13', identifier: '1234567890123' },
        ],
      },
    },
  },
);
assert.equal(imported.status, 200, JSON.stringify(imported.data));
assert.equal(
  (await request(`/api/books/${imported.data.data.book.id}`, b.cookie)).status,
  200,
);
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
try {
  await db.execute(
    `CREATE TRIGGER audit_reject_author_link BEFORE INSERT ON book_authors WHEN (SELECT title FROM books WHERE id = NEW.book_id) = 'Rollback Probe' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
  );
  const failedEdit = await request(`/api/books/${aBook}`, a.cookie, 'PUT', {
    title: 'Rollback Probe',
    authors: ['Failure Writer'],
  });
  assert.equal(failedEdit.status, 500);
  const afterFailure = await request(`/api/books/${aBook}`, a.cookie);
  assert.equal(afterFailure.data.data.book.title, 'Edited Audit Book');
  const failedImport = await request(
    '/api/books/metadata-import/create',
    b.cookie,
    'POST',
    {
      provider: 'googleBooks',
      item: {
        id: 'rollback',
        volumeInfo: { title: 'Rollback Probe', authors: ['Failure Writer'] },
      },
    },
  );
  assert.equal(failedImport.status, 500);
  const orphans = await db.execute(
    "SELECT id FROM books WHERE title = 'Rollback Probe'",
  );
  assert.equal(orphans.rows.length, 0);
} finally {
  await db.execute('DROP TRIGGER IF EXISTS audit_reject_author_link');
  db.close();
}
const extraBooks = [];
for (const title of ['Status Two', 'Status Three']) {
  const result = await request('/api/books', a.cookie, 'POST', {
    title,
    authors: ['Status Writer'],
  });
  assert.equal(result.status, 200);
  extraBooks.push(result.data.data.book.id);
}
const statusIds = [aBook, ...extraBooks];
const bulkSet = await request('/api/books/bulk/status', a.cookie, 'POST', {
  bookIds: statusIds,
  status: 'to_be_read',
});
assert.equal(bulkSet.status, 200, JSON.stringify(bulkSet.data));
assert.equal(bulkSet.data.data.updated, 3);
async function ranks() {
  return Promise.all(
    statusIds.map(
      async (id) =>
        (await request(`/api/books/${id}/status`, a.cookie)).data.data.tbrRank,
    ),
  );
}
assert.deepEqual(await ranks(), [1, 2, 3]);
assert.equal(
  (
    await request(`/api/books/${aBook}/status`, a.cookie, 'POST', {
      status: null,
    })
  ).status,
  200,
);
assert.deepEqual(await ranks(), [null, 1, 2]);
assert.equal(
  (
    await request(`/api/books/${aBook}/status`, a.cookie, 'POST', {
      status: 'to_be_read',
      tbrRank: 1,
    })
  ).status,
  200,
);
assert.deepEqual(await ranks(), [1, 2, 3]);
const clear = await request('/api/books/bulk/status', a.cookie, 'POST', {
  bookIds: [extraBooks[0]],
  status: null,
});
assert.equal(clear.data.data.cleared, 1);
assert.deepEqual(await ranks(), [1, null, 2]);
const concurrent = await Promise.all(
  statusIds.map((id) =>
    request('/api/books/bulk/status', a.cookie, 'POST', {
      bookIds: [id],
      status: 'to_be_read',
    }),
  ),
);
for (const response of concurrent)
  assert.equal(response.status, 200, JSON.stringify(response.data));
assert.deepEqual(
  (await ranks()).sort((x, y) => x - y),
  [1, 2, 3],
);
const overlap = await Promise.all([
  request('/api/books/bulk/status', a.cookie, 'POST', {
    bookIds: statusIds,
    status: 'reading',
  }),
  request('/api/books/bulk/status', a.cookie, 'POST', {
    bookIds: statusIds,
    status: 'reading',
  }),
]);
for (const response of overlap) {
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.data.updated, 3);
}
for (const id of statusIds) {
  const state = (await request(`/api/books/${id}/status`, a.cookie)).data.data;
  assert.equal(state.status, 'reading');
  assert.ok(state.startedAt);
  assert.equal(state.tbrRank, null);
}
const restore = await request('/api/books/bulk/status', a.cookie, 'POST', {
  bookIds: statusIds,
  status: 'to_be_read',
});
assert.equal(restore.data.data.updated, 3);
const finished = await request(`/api/books/${aBook}/status`, a.cookie, 'POST', {
  status: 'finished',
});
assert.equal(finished.status, 200);
assert.ok(finished.data.data.startedAt && finished.data.data.finishedAt);
assert.deepEqual(
  (await ranks()).filter((x) => x !== null).sort((x, y) => x - y),
  [1, 2],
);
for (const [title, published] of [
  ['Date tie one', '2022-01-01'],
  ['Date tie two', '2022-01-01'],
  ['Date later', '2024-01-01'],
  ['Date unknown', null],
]) {
  const created = await request('/api/books', a.cookie, 'POST', {
    title,
    published,
    authors: ['Date Writer'],
  });
  assert.equal(created.status, 200);
}
for (const direction of ['asc', 'desc']) {
  const full = await request(
    `/api/books?sort=publishedDate&sortDir=${direction}&limit=200`,
    a.cookie,
  );
  assert.equal(full.status, 200);
  const expected = full.data.data.books.map((book) => book.id);
  const found = [];
  let cursor = null;
  do {
    const page = await request(
      `/api/books?sort=publishedDate&sortDir=${direction}&limit=1${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      a.cookie,
    );
    assert.equal(page.status, 200);
    found.push(...page.data.data.books.map((book) => book.id));
    cursor = page.data.data.nextCursor;
    assert.ok(found.length <= expected.length);
  } while (cursor);
  assert.deepEqual(found, expected);
}
const transfer = await request(
  `/api/collections/${aCollection}/transfer-ownership`,
  a.cookie,
  'POST',
  { email: b.email },
);
assert.equal(transfer.status, 200, JSON.stringify(transfer.data));
assert.equal(
  (
    await request(
      `/api/collections/${aCollection}/transfer-ownership`,
      a.cookie,
      'POST',
      { email: b.email },
    )
  ).status,
  403,
);
const adminUser = await signup('admin');
const authDb = createClient({ url: 'file:./review/demo/synthetic.db' });
try {
  const collectionOwners = await authDb.execute({
    sql: "SELECT user_id FROM collection_members WHERE collection_id = ? AND role = 'owner'",
    args: [aCollection],
  });
  assert.equal(collectionOwners.rows.length, 1);
  assert.equal(collectionOwners.rows[0].user_id, b.id);
  const owner = await authDb.execute(
    "SELECT id FROM users WHERE role = 'owner' LIMIT 1",
  );
  assert.equal(owner.rows.length, 1);
  await authDb.execute({
    sql: "UPDATE users SET role = 'admin' WHERE id = ?",
    args: [adminUser.id],
  });
  for (const [path, body] of [
    ['/api/auth/admin/remove-user', { userId: owner.rows[0].id }],
    ['/api/auth/admin/set-role', { userId: owner.rows[0].id, role: 'user' }],
    [
      '/api/auth/admin/update-user',
      { userId: owner.rows[0].id, data: { role: 'user' } },
    ],
    ['/api/users/delete', { id: owner.rows[0].id }],
  ]) {
    const response = await request(
      path,
      adminUser.cookie,
      path === '/api/users/delete' ? 'DELETE' : 'POST',
      body,
    );
    assert.equal(
      response.status,
      path === '/api/users/delete' ? 404 : 403,
      `${path} returned ${response.status}: ${JSON.stringify(response.data)}`,
    );
  }
  assert.equal(
    (
      await authDb.execute({
        sql: 'SELECT role FROM users WHERE id = ?',
        args: [owner.rows[0].id],
      })
    ).rows[0].role,
    'owner',
  );
} finally {
  authDb.close();
}
console.log('Synthetic HTTP regression checks passed');

const settingsRevision = Date.now();
const savedSettings = await request('/api/settings/user', b.cookie, 'PUT', {
  settings: { fontFamily: 'Inter' },
  updatedAt: settingsRevision + 2,
});
assert.equal(savedSettings.status, 200);
assert.equal(savedSettings.data.accepted, true);
const rejectedSettings = await request('/api/settings/user', b.cookie, 'PUT', {
  settings: { fontFamily: 'Nunito' },
  updatedAt: settingsRevision + 1,
});
assert.equal(rejectedSettings.data.accepted, false);
assert.equal(rejectedSettings.data.data.settings.fontFamily, 'Inter');
assert.equal(
  new Date(rejectedSettings.data.data.updatedAt).getTime(),
  settingsRevision + 2,
);
const repeatedSettings = await request('/api/settings/user', b.cookie, 'PUT', {
  settings: { fontFamily: 'Inter' },
  updatedAt: settingsRevision + 2,
});
assert.equal(repeatedSettings.data.accepted, true);
console.log(
  'PASS production settings retain millisecond order and acknowledge writes',
);
