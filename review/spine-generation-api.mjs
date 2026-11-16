import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { createClient } from '@libsql/client';
import { fetchAuth } from './fetch-auth.mjs';

const base = 'http://127.0.0.1:4317';
const suffix = randomBytes(6).toString('hex');
async function signup(role) {
  const email = `spine-${role}-${suffix}@example.invalid`;
  const response = await fetchAuth(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: role,
      email,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const { user } = await response.json();
  return {
    id: user.id,
    email,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
async function request(path, account, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: base,
      ...(account ? { Cookie: account.cookie } : {}),
      ...(body && !(body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    ...(body
      ? { body: body instanceof FormData ? body : JSON.stringify(body) }
      : {}),
  });
  return response;
}
const owner = await signup('owner'),
  editor = await signup('editor'),
  viewer = await signup('viewer'),
  outsider = await signup('outsider');
const createdCollection = await request('/api/collections', owner, 'POST', {
  name: `Spine fixture ${suffix}`,
});
assert.equal(
  createdCollection.status,
  200,
  await createdCollection.clone().text(),
);
const collection = (await createdCollection.json()).data.collection.id;
for (const [account, role] of [
  [editor, 'editor'],
  [viewer, 'viewer'],
]) {
  const response = await request(
    `/api/collections/${collection}/members`,
    owner,
    'PUT',
    { email: account.email, role },
  );
  assert.equal(response.status, 200, await response.clone().text());
}
const created = await request('/api/books', owner, 'POST', {
  title: 'Spine fixture',
  authors: ['Sample Author'],
  collectionIds: [collection],
});
assert.equal(created.status, 200, await created.clone().text());
const id = (await created.json()).data.book.id,
  path = `/api/books/${id}/spine`;
const connection = `/api/books/${id}/spine-generate/connection`;
const adminConnection = '/api/settings/admin/chatgpt-image';
const setupDb = createClient({ url: 'file:./review/demo/synthetic.db' });
await setupDb.execute({
  sql: "UPDATE users SET role = 'admin' WHERE id = ?",
  args: [outsider.id],
});
await setupDb.execute({
  sql: "INSERT INTO codex_image_connections (user_id, generation, state, encrypted_tokens) VALUES (?, 'old-personal', 'connected', 'preserved')",
  args: [editor.id],
});
setupDb.close();
const generation = `/api/books/${id}/spine-generate`;
assert.equal((await request(connection, null)).status, 401);
assert.equal((await request(connection, viewer)).status, 403);
assert.equal((await request(connection, outsider)).status, 404);
assert.equal(
  (await request(generation, viewer, 'POST', new FormData())).status,
  403,
);
assert.equal(
  (await request(adminConnection, editor, 'POST', { action: 'start' })).status,
  403,
);
assert.equal(
  (await request(connection, editor, 'POST', { action: 'start' })).status,
  405,
);
let response = await request(adminConnection, owner, 'POST', {
  action: 'start',
});
assert.equal(response.status, 200, await response.clone().text());
const challenge = await response.json();
assert.equal(challenge.code, 'TEST-CODE');
assert.equal(
  (
    await request(adminConnection, outsider, 'POST', {
      action: 'poll',
      attemptId: challenge.attemptId,
    })
  ).status,
  410,
);
await new Promise((resolve) => setTimeout(resolve, 3100));
response = await request(adminConnection, owner, 'POST', {
  action: 'poll',
  attemptId: challenge.attemptId,
});
assert.equal(response.status, 200, await response.clone().text());
assert.equal((await response.json()).connected, true);
const database = createClient({ url: 'file:./review/demo/synthetic.db' });
const stored = await database.execute(
  'SELECT encrypted_tokens FROM shared_codex_image_connection',
);
assert.equal(stored.rows.length, 1);
assert.ok(!String(stored.rows[0].encrypted_tokens).includes('synthetic-'));
database.close();
assert.equal(
  (await (await request(connection, editor)).json()).connected,
  true,
);
assert.equal((await (await request(connection, owner)).json()).connected, true);
const empty = new FormData();
empty.append('prompt', '');
assert.equal((await request(generation, editor, 'POST', empty)).status, 404);
const cover = await sharp({
  create: { width: 100, height: 180, channels: 3, background: '#cc3344' },
})
  .png()
  .toBuffer();
const upload = new FormData();
upload.append('file', new Blob([cover], { type: 'image/png' }), 'cover.png');
response = await request(`/api/books/${id}/cover`, editor, 'POST', upload);
assert.equal(response.status, 200, await response.clone().text());
const first = new FormData();
first.append('prompt', 'Use gold lettering');
response = await request(generation, editor, 'POST', first);
assert.equal(response.status, 200, await response.clone().text());
const bytes = Buffer.from(await response.arrayBuffer());
const metadata = await sharp(bytes).metadata();
assert.equal(metadata.width, 180);
assert.equal(metadata.height, 100);
assert.equal(
  (await (await request(`${path}?variant=metadata`, editor)).json()).exists,
  false,
);
const second = new FormData();
second.append('prompt', 'Make the title larger');
second.append(
  'previous',
  new Blob([bytes], { type: 'image/png' }),
  'draft.png',
);
response = await request(generation, editor, 'POST', second);
assert.equal(response.status, 200, await response.clone().text());
const updated = Buffer.from(await response.arrayBuffer());
const save = new FormData();
save.append('file', new Blob([updated], { type: 'image/png' }), 'spine.png');
save.append('revision', '');
save.append(
  'edits',
  JSON.stringify({ left: 0, right: 0, top: 0, bottom: 0, stretch: false }),
);
response = await request(path, editor, 'POST', save);
assert.equal(response.status, 200, await response.clone().text());
assert.equal(
  (await (await request(`${path}?variant=metadata`, viewer)).json()).exists,
  true,
);
const calls = (
  await (
    await import('node:fs/promises')
  ).readFile('review/demo/fake-codex-calls.jsonl', 'utf8')
)
  .trim()
  .split('\n')
  .map(JSON.parse);
assert.deepEqual(
  calls.map((c) => c.images),
  [1, 2],
);
assert.match(calls[0].prompt, /personal use/);
assert.match(calls[0].prompt, /not for distribution/);
assert.match(calls[1].prompt, /Make the title larger/);
assert.ok(
  (
    await (
      await import('node:fs/promises')
    ).readFile('review/demo/fake-codex-refreshes.txt', 'utf8')
  ).includes('refresh'),
);
const delayed = new FormData();
delayed.append('prompt', 'WAIT_FOR_PERMISSION');
const pending = request(generation, editor, 'POST', delayed);
const files = await import('node:fs/promises');
for (let attempt = 0; attempt < 100; attempt++) {
  if (
    (
      await files.readFile('review/demo/fake-codex-calls.jsonl', 'utf8')
    ).includes('WAIT_FOR_PERMISSION')
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(
  (await files.readFile('review/demo/fake-codex-calls.jsonl', 'utf8')).includes(
    'WAIT_FOR_PERMISSION',
  ),
);
response = await request(
  `/api/collections/${collection}/members`,
  owner,
  'PUT',
  { email: editor.email, role: 'viewer' },
);
assert.equal(response.status, 200, await response.clone().text());
assert.equal((await pending).status, 403);
assert.equal((await request(connection, editor)).status, 403);
assert.equal((await request(adminConnection, editor, 'DELETE')).status, 403);
assert.equal((await request(adminConnection, owner, 'DELETE')).status, 200);
assert.equal(
  (await (await request(adminConnection, owner)).json()).connected,
  false,
);
const finalDb = createClient({ url: 'file:./review/demo/synthetic.db' });
const previous = await finalDb.execute({
  sql: 'SELECT encrypted_tokens FROM codex_image_connections WHERE user_id = ?',
  args: [editor.id],
});
assert.equal(previous.rows[0].encrypted_tokens, 'preserved');
finalDb.close();
console.log('Spine generation API passed with a fake Codex provider');
