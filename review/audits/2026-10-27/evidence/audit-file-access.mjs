import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
const base = 'http://127.0.0.1:4317';
const response = await fetch(base + '/api/auth/sign-up/email', {
  method: 'POST',
  headers: { Origin: base, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Audit download',
    email: 'audit-download@example.invalid',
    password: randomBytes(20).toString('hex'),
  }),
});
assert.equal(response.status, 200);
const cookie = response.headers
  .getSetCookie()
  .map((v) => v.split(';')[0])
  .join('; ');
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
const row = (await db.execute('SELECT book_id FROM book_files LIMIT 1'))
  .rows[0];
db.close();
assert.ok(row);
async function req(p, method = 'GET', body) {
  return fetch(base + p, {
    method,
    headers: {
      Cookie: cookie,
      Origin: base,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const before = await req(`/api/books/${row.book_id}/download?format=epub`);
await before.arrayBuffer();
assert.ok([403, 404].includes(before.status));
const c = await req('/api/collections', 'POST', { name: 'Download proof' });
const id = (await c.json()).data.collection.id;
const added = await req(`/api/collections/${id}/books/bulk`, 'POST', {
  bookIds: [row.book_id],
  addToCollectionIds: [id],
});
await added.arrayBuffer();
assert.equal(added.status, 200);
const after = await req(`/api/books/${row.book_id}/download?format=epub`);
const bytes = new Uint8Array(await after.arrayBuffer());
assert.equal(after.status, 200);
assert.equal(bytes[0], 80);
assert.equal(bytes[1], 75);
const evidence = {
  check: 'Private EPUB download granted by arbitrary bulk assignment',
  before: before.status,
  assignment: added.status,
  after: after.status,
  zipMagic: 'PK',
  bytes: bytes.length,
};
console.log(JSON.stringify(evidence));
await writeFile(
  'audit-file-access-results.json',
  JSON.stringify(evidence, null, 2) + '\n',
);
