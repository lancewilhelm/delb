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
record('PASS shared default collection listing');
const bookId = uploadData.data.results.find((result) => result.success).book.id;
const originalBytes = await readFile('review/demo/ordinary.epub');
for (const title of ['日本語の本 📚', '100% done; %2F stays literal']) {
  const edited = await fetch(`${base}/api/books/${bookId}`, {
    method: 'PUT',
    headers: {
      Cookie: cookies,
      Origin: base,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  });
  assert.equal(edited.status, 200, await edited.text());
  const download = await fetch(`${base}/api/books/${bookId}/download`, {
    headers: { Cookie: cookies },
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.equal(download.headers.get('content-type'), 'application/epub+zip');
  const disposition = download.headers.get('content-disposition');
  assert.equal(
    decodeURIComponent(
      /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1] || '',
    ),
    `${title}.epub`,
  );
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), originalBytes);
}
record(
  'PASS Unicode and percent-sign filenames round-trip with unchanged EPUB bytes',
);
assert.equal((await fetch(`${base}/api/books/${bookId}/download`)).status, 401);
const otherRegistration = await fetchAuth(base + '/api/auth/sign-up/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({
    email: 'delb-other-review@example.invalid',
    name: 'Other Synthetic Reader',
    password: randomBytes(20).toString('hex'),
  }),
});
assert.equal(otherRegistration.status, 200);
const otherCookies = otherRegistration.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
const defaultCollection = (await collection.json()).data.find(
  (item) => item.isDefault,
);
assert.ok(defaultCollection);
const left = await fetch(
  `${base}/api/collections/${defaultCollection.id}/leave`,
  {
    method: 'POST',
    headers: { Cookie: otherCookies, Origin: base },
  },
);
assert.equal(left.status, 200, await left.text());
assert.equal(
  (
    await fetch(`${base}/api/books/${bookId}/download`, {
      headers: { Cookie: otherCookies },
    })
  ).status,
  404,
);
record('PASS downloads reject guests and users without book visibility');
await writeFile('review/http-smoke-results.txt', output.join('\n') + '\n');
// Session/password values remain in memory; no credentials are saved or logged.
