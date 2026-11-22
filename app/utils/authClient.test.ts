import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDelbAuthClient, extractAuthError } from './authClient';

test('createDelbAuthClient sends expected /api/auth/* requests with credentials', async () => {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const client = createDelbAuthClient(async (url, options) => {
    calls.push({ url, options: (options ?? {}) as Record<string, unknown> });
    if (url === '/api/auth/get-session') {
      return {
        session: { id: 's1', userId: 'u1' },
        user: { id: 'u1', email: 'a@b.com', name: 'Alice', role: 'owner' },
      } as never;
    }
    return { ok: true } as never;
  });

  const sessionRes = await client.getSession();
  assert.equal(sessionRes.error, null);
  assert.equal(sessionRes.data?.user.id, 'u1');

  await client.signIn.email({ email: 'a@b.com', password: 'secret' });
  await client.signUp.email({
    email: 'b@b.com',
    password: 'secret',
    name: 'Bob',
  });
  await client.signOut();
  await client.changePassword({ currentPassword: 'old', newPassword: 'new' });
  await client.changeEmail({ newEmail: 'new@b.com' });
  await client.updateUser({ name: 'Alice 2' });
  await client.admin.listUsers({ query: { limit: 100 } });
  await client.admin.createUser({
    email: 'c@b.com',
    password: 'secret',
    name: 'Carl',
    role: 'user',
  });
  await client.admin.removeUser({ userId: 'u2' });
  await client.admin.banUser({ userId: 'u2' });
  await client.admin.unbanUser({ userId: 'u2' });
  await client.admin.updateUser({ userId: 'u2', data: { role: 'admin' } });
  await client.admin.setUserPassword({ userId: 'u2', newPassword: 'pw' });

  assert.deepEqual(
    calls.map((c) => [c.options.method, c.url, c.options.credentials]),
    [
      ['GET', '/api/auth/get-session', 'include'],
      ['POST', '/api/auth/sign-in/email', 'include'],
      ['POST', '/api/auth/sign-up/email', 'include'],
      ['POST', '/api/auth/sign-out', 'include'],
      ['POST', '/api/auth/change-password', 'include'],
      ['POST', '/api/auth/change-email', 'include'],
      ['POST', '/api/auth/update-user', 'include'],
      ['GET', '/api/auth/admin/list-users', 'include'],
      ['POST', '/api/auth/admin/create-user', 'include'],
      ['POST', '/api/auth/admin/remove-user', 'include'],
      ['POST', '/api/auth/admin/ban-user', 'include'],
      ['POST', '/api/auth/admin/unban-user', 'include'],
      ['POST', '/api/auth/admin/update-user', 'include'],
      ['POST', '/api/auth/admin/set-user-password', 'include'],
    ],
  );
  assert.deepEqual(calls[7]?.options.query, { limit: 100 });
});

test('extractAuthError normalizes ofetch errors and auth payloads', async () => {
  const client = createDelbAuthClient(async () => {
    throw {
      statusCode: 401,
      data: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid password' },
      message: 'Fetch error',
    };
  });

  const res = await client.signIn.email({ email: 'a@b.com', password: 'bad' });
  assert.equal(res.data, null);
  assert.deepEqual(res.error, {
    message: 'Invalid password',
    code: 'INVALID_EMAIL_OR_PASSWORD',
    status: 401,
  });

  assert.deepEqual(
    extractAuthError({
      response: { status: 429, _data: { error: 'Too many requests' } },
    }),
    {
      message: 'Too many requests',
      code: undefined,
      status: 429,
    },
  );
});
