import { fetchAuth } from './fetch-auth.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const base = 'http://127.0.0.1:4317';
const output = [];
const record = (text) => {
  output.push(text);
  console.log(text);
};
const guest = await fetch(base + '/api/books');
assert.equal(guest.status, 401);
record('PASS unauthenticated book listing returns 401');
const registration = await fetchAuth(base + '/api/auth/sign-up/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({
    email: 'delb-review@example.invalid',
    name: 'Synthetic Reader',
    password: randomBytes(20).toString('hex'),
  }),
});
assert.equal(registration.status, 200, 'synthetic registration must succeed');
const cookies = registration.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
assert.ok(cookies);
record('PASS synthetic registration in disposable database');
const form = new FormData();
form.append(
  'file',
  new Blob([await readFile('review/demo/ordinary.epub')], {
    type: 'application/epub+zip',
  }),
  'ordinary.epub',
);
const upload = await fetch(base + '/api/books/upload', {
  method: 'POST',
  headers: { Cookie: cookies, Origin: base },
  body: form,
});
const uploadData = await upload.json();
assert.ok(
  uploadData.data.results.some((result) => result.success),
  'upload must report success',
);
assert.equal(upload.status, 200);
const list = await fetch(base + '/api/books', { headers: { Cookie: cookies } });
assert.equal(list.status, 200);
const listData = await list.json();
const serialized = JSON.stringify(listData);
assert.ok(
  serialized.includes('Synthetic ordinary book'),
  'uploaded synthetic book must appear in authenticated list',
);
record('PASS synthetic EPUB upload and authenticated book listing');
const collection = await fetch(base + '/api/collections', {
  headers: { Cookie: cookies },
});
assert.equal(collection.status, 200);
record('PASS personal collection listing');
await writeFile('review/http-smoke-results.txt', output.join('\n') + '\n');
// Session/password values remain in memory; no credentials are saved or logged.
