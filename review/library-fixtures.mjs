import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fetchAuth } from './fetch-auth.mjs';

export const base = (
  process.env.DELB_REVIEW_URL ||
  process.env.BASE_URL ||
  'http://127.0.0.1:4317'
).replace(/\/$/, '');

export async function request(actor, path, method = 'GET', body) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const send = path.startsWith('/api/auth/') ? fetchAuth : fetch;
  return send(base + path, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      Origin: base,
      ...(actor ? { Cookie: actor.cookie } : {}),
      ...(body !== undefined && !(body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    ...(body === undefined
      ? {}
      : {
          body: body instanceof FormData ? body : JSON.stringify(body),
        }),
  });
}

export async function expectStatus(response, status = 200) {
  assert.equal(
    response.status,
    status,
    `${response.url}: ${await response.clone().text()}`,
  );
  return response;
}

export async function json(response) {
  return (await expectStatus(response)).json();
}

export async function account(name) {
  const response = await expectStatus(
    await request(null, '/api/auth/sign-up/email', 'POST', {
      name,
      email: `${name}-${randomBytes(6).toString('hex')}@example.invalid`,
      password: randomBytes(20).toString('hex'),
    }),
  );
  return {
    ...(await response.json()).user,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}

export async function setRole(admin, target, role) {
  await expectStatus(
    await request(admin, '/api/auth/admin/set-role', 'POST', {
      userId: target.id,
      role,
    }),
  );
}

export const rulesPath = (userId) =>
  `/api/settings/admin/users/${userId}/tag-rules`;

export async function setTagRules(
  admin,
  target,
  { allowTagIds = [], blockTagIds = [] } = {},
) {
  return (
    await json(
      await request(admin, rulesPath(target.id), 'PUT', {
        allowTagIds,
        blockTagIds,
      }),
    )
  ).data;
}

export async function tagBook(editor, bookId, tagName) {
  const path = `/api/books/${bookId}`;
  const { data } = await json(await request(editor, path));
  await expectStatus(
    await request(editor, path, 'PUT', {
      tags: [...data.tags.map((tag) => tag.name), tagName],
    }),
  );
  const tagged = await json(await request(editor, path));
  const tag = tagged.data.tags.find((tag) => tag.name === tagName);
  assert.ok(tag, `Expected tag "${tagName}" on ${bookId}`);
  return tag;
}
