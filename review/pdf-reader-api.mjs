import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { fetchAuth } from './fetch-auth.mjs';
import { pdfFixture } from './pdf-fixture.mjs';

const base = 'http://127.0.0.1:4317';
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
async function signup() {
  const response = await fetchAuth(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'PDF Review',
      email: `pdf-${randomBytes(6).toString('hex')}@example.invalid`,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return {
    id: (await response.json()).user.id,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
  };
}
async function request(route, user, method = 'GET', body) {
  return fetch(base + route, {
    method,
    headers: {
      Origin: base,
      ...(user ? { Cookie: user.cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const owner = await signup();
const viewer = await signup();
try {
  const bytes = pdfFixture();
  const form = new FormData();
  form.append(
    'files',
    new Blob([bytes], { type: 'application/pdf' }),
    'Simple PDF.pdf',
  );
  const uploaded = await fetch(base + '/api/books/upload', {
    method: 'POST',
    headers: { Origin: base, Cookie: owner.cookie },
    body: form,
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const upload = await uploaded.json();
  assert.ok(upload.success, JSON.stringify(upload));
  const books = (await (await request('/api/books', owner)).json()).data.books;
  const book = books.find((book) => book.title === 'Simple PDF');
  assert.ok(book, JSON.stringify(books));
  const id = book.id;
  const files = (await (await request(`/api/books/${id}/files`, owner)).json())
    .data.files;
  assert.equal(files[0].format, 'pdf');
  const download = `/api/books/${id}/download?format=pdf&fileId=${files[0].id}`;
  assert.equal((await request(download)).status, 401);
  assert.equal((await request(download, viewer)).status, 404);
  assert.equal(
    (await request(`/api/books/${id}/reading-position`, viewer)).status,
    404,
  );
  assert.equal(
    (await request(`/api/books/${id}/download?format=epub`, owner)).status,
    404,
  );
  assert.equal(
    (await request(`/api/books/${id}/download?format=pdf&fileId=other`, owner))
      .status,
    404,
  );
  const downloaded = await request(download, owner);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'application/pdf');
  assert.equal(downloaded.headers.get('cache-control'), 'private, no-store');
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);

  const sharedResponse = await request('/api/collections', owner, 'POST', {
    name: 'Shared PDF review',
  });
  const shared = (await sharedResponse.json()).data.collection.id;
  await db.execute({
    sql: "INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES (?,?,'viewer',0)",
    args: [shared, viewer.id],
  });
  await db.execute({
    sql: 'INSERT INTO collection_books(collection_id,book_id,added_by_user_id,added_at) VALUES (?,?,?,0)',
    args: [shared, id, owner.id],
  });
  assert.equal((await request(download, viewer)).status, 200);
  const clientSessionId = randomUUID();
  const position = {
    location: `pdf:${files[0].id}:2`,
    progress: 200 / 3,
    clientSessionId,
    clientSequence: 2,
  };
  const put = await request(
    `/api/books/${id}/reading-position`,
    owner,
    'PUT',
    position,
  );
  assert.equal(put.status, 200);
  await request(`/api/books/${id}/reading-position`, owner, 'PUT', {
    ...position,
    location: `pdf:${files[0].id}:1`,
    clientSequence: 1,
  });
  assert.equal(
    (await (await request(`/api/books/${id}/reading-position`, owner)).json())
      .data.location,
    position.location,
  );
  assert.equal(
    (await (await request(`/api/books/${id}/reading-position`, viewer)).json())
      .data.location,
    null,
  );
  assert.equal(
    (await (await request(`/api/books/${id}/progress-logs`, owner)).json()).data
      .logs.length,
    0,
  );
  const sync = await request(`/api/books/${id}/progress-sync`, owner, 'PUT', {
    enabled: true,
  });
  assert.equal(sync.status, 200);
  await request(`/api/books/${id}/reading-position`, owner, 'PUT', {
    ...position,
    location: `pdf:${files[0].id}:3`,
    progress: 100,
    clientSequence: 3,
  });
  assert.equal(
    (await (await request(`/api/books/${id}/progress-logs`, owner)).json()).data
      .logs[0].progressPercent,
    100,
  );
  await db.execute({
    sql: 'DELETE FROM collection_members WHERE collection_id=? AND user_id=?',
    args: [shared, viewer.id],
  });
  assert.equal((await request(download, viewer)).status, 404);
  assert.equal(
    (
      await request(`/api/books/${id}/reading-position`, viewer, 'PUT', {
        location: 'pdf:fake:1',
      })
    ).status,
    404,
  );
  console.log(
    'PASS PDF upload/download bytes, MIME, auth, visibility, file selection, private ordered positions, opt-in progress sync, and revoked access',
  );
} finally {
  db.close();
}
