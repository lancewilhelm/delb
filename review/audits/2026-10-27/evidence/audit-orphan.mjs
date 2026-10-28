import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
const base = 'http://127.0.0.1:4317';
const reg = await fetch(base + '/api/auth/sign-up/email', {
  method: 'POST',
  headers: { Origin: base, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Orphan Audit',
    email: 'audit-orphan@example.invalid',
    password: randomBytes(20).toString('hex'),
  }),
});
assert.equal(reg.status, 200);
const cookie = reg.headers
  .getSetCookie()
  .map((x) => x.split(';')[0])
  .join('; ');
const title = 'Synthetic Duplicate Identifier Orphan';
const res = await fetch(base + '/api/books/metadata-import/create', {
  method: 'POST',
  headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: 'googleBooks',
    duplicateAction: 'add_new',
    item: {
      id: 'orphan-proof',
      volumeInfo: {
        title,
        authors: ['Orphan Proof Author'],
        industryIdentifiers: [
          { type: 'ISBN_13', identifier: '9780000000011' },
          { type: 'ISBN_13', identifier: '9780000000028' },
        ],
      },
    },
  }),
});
await res.arrayBuffer();
assert.equal(res.status, 500);
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
const result = await db.execute({
  sql: 'SELECT b.id,(SELECT count(*) FROM collection_books cb WHERE cb.book_id=b.id) AS collection_count FROM books b WHERE b.title=?',
  args: [title],
});
db.close();
assert.equal(result.rows.length, 1);
assert.equal(result.rows[0].collection_count, 0);
const out = {
  check: 'Metadata import fails after persisting invisible orphan',
  response: res.status,
  bookRows: result.rows.length,
  collectionCount: result.rows[0].collection_count,
};
console.log(JSON.stringify(out));
await writeFile(
  'audit-orphan-results.json',
  JSON.stringify(out, null, 2) + '\n',
);
