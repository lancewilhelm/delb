import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { sharedCodexImageConnection } from '~~/server/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';

const sharedId = 'spine-generation';
const issuer = 'https://auth.openai.com';
const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
type Attempt = {
  userId: string;
  sessionId: string;
  generation: string;
  deviceId: string;
  code: string;
  expiresAt: number;
  nextPoll: number;
  interval: number;
  busy: boolean;
};
const attempts = new Map<string, Attempt>();

function key() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw createError({
      statusCode: 503,
      statusMessage:
        'Set a persistent BETTER_AUTH_SECRET of at least 32 characters to connect ChatGPT.',
    });
  return createHash('sha256')
    .update('delb-codex-image-v1\0')
    .update(secret)
    .digest();
}
function encrypt(tokens: Tokens) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(sharedId));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(tokens), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function decrypt(value: string): Tokens {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(sharedId));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const raw: unknown = JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString('utf8'),
  );
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('accessToken' in raw) ||
    typeof raw.accessToken !== 'string' ||
    !('refreshToken' in raw) ||
    typeof raw.refreshToken !== 'string' ||
    !('expiresAt' in raw) ||
    typeof raw.expiresAt !== 'number'
  )
    throw new Error('Invalid credential');
  return {
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    expiresAt: raw.expiresAt,
  };
}
function parseTokens(value: unknown, existingRefreshToken?: string): Tokens {
  if (
    !value ||
    typeof value !== 'object' ||
    !('access_token' in value) ||
    typeof value.access_token !== 'string' ||
    !value.access_token
  )
    throw new Error('Invalid token response');
  const refreshToken =
    'refresh_token' in value &&
    typeof value.refresh_token === 'string' &&
    value.refresh_token
      ? value.refresh_token
      : existingRefreshToken;
  if (!refreshToken) throw new Error('Missing refresh token');
  const expires =
    'expires_in' in value && typeof value.expires_in === 'number'
      ? value.expires_in
      : 3600;
  let expiresAt = Date.now() + Math.max(0, expires) * 1000;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(value.access_token.split('.')[1] ?? '', 'base64url').toString(
        'utf8',
      ),
    );
    if (
      payload &&
      typeof payload === 'object' &&
      'exp' in payload &&
      typeof payload.exp === 'number'
    )
      expiresAt = Math.min(expiresAt, payload.exp * 1000);
  } catch {
    /* A token without a readable expiry uses the provider's expires_in. */
  }
  return { accessToken: value.access_token, refreshToken, expiresAt };
}
async function providerPost(url: string, body: BodyInit, contentType: string) {
  return await fetch(url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
}
export async function connectionStatus() {
  const [row] = await cloudDb
    .select()
    .from(sharedCodexImageConnection)
    .where(eq(sharedCodexImageConnection.id, sharedId));
  return {
    connected: row?.state === 'connected',
    reconnectRequired: !!row && row.state !== 'connected',
  };
}
export async function disconnect() {
  attempts.clear();
  await cloudDb
    .delete(sharedCodexImageConnection)
    .where(eq(sharedCodexImageConnection.id, sharedId));
}
export async function startConnection(
  userId: string,
  sessionId: string,
  authorize: () => Promise<void>,
) {
  key();
  const generation = randomUUID();
  await cloudDb
    .insert(sharedCodexImageConnection)
    .values({
      id: sharedId,
      generation,
      state: 'connecting',
      encryptedTokens: null,
    })
    .onConflictDoUpdate({
      target: sharedCodexImageConnection.id,
      set: { generation, state: 'connecting', encryptedTokens: null },
    });
  const response = await providerPost(
    `${issuer}/api/accounts/deviceauth/usercode`,
    JSON.stringify({ client_id: clientId }),
    'application/json',
  );
  if (!response.ok)
    throw createError({
      statusCode: 502,
      statusMessage: 'Could not start ChatGPT sign-in. Try again.',
    });
  const raw: unknown = await response.json();
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('device_auth_id' in raw) ||
    typeof raw.device_auth_id !== 'string' ||
    !('user_code' in raw) ||
    typeof raw.user_code !== 'string'
  )
    throw createError({
      statusCode: 502,
      statusMessage: 'ChatGPT returned an invalid sign-in response.',
    });
  const interval =
    'interval' in raw && Number.isFinite(Number(raw.interval))
      ? Math.max(3, Math.min(60, Number(raw.interval)))
      : 5;
  await authorize();
  const [current] = await cloudDb
    .select({
      generation: sharedCodexImageConnection.generation,
      state: sharedCodexImageConnection.state,
    })
    .from(sharedCodexImageConnection)
    .where(eq(sharedCodexImageConnection.id, sharedId));
  if (current?.generation !== generation || current.state !== 'connecting')
    throw createError({
      statusCode: 409,
      statusMessage: 'ChatGPT connection changed. Start again.',
    });
  for (const [id, existing] of attempts)
    if (existing.generation !== generation || existing.expiresAt < Date.now())
      attempts.delete(id);
  const attemptId = randomUUID();
  attempts.set(attemptId, {
    userId,
    sessionId,
    generation,
    deviceId: raw.device_auth_id,
    code: raw.user_code,
    expiresAt: Date.now() + 15 * 60_000,
    nextPoll: Date.now() + interval * 1000,
    interval,
    busy: false,
  });
  return {
    attemptId,
    code: raw.user_code,
    url: `${issuer}/codex/device`,
    interval,
  };
}
export async function pollConnection(
  userId: string,
  sessionId: string,
  attemptId: string,
  authorize: () => Promise<void>,
) {
  const attempt = attempts.get(attemptId);
  if (
    !attempt ||
    attempt.userId !== userId ||
    attempt.sessionId !== sessionId ||
    attempt.expiresAt < Date.now()
  )
    throw createError({
      statusCode: 410,
      statusMessage: 'Sign-in expired. Start again.',
    });
  if (attempt.busy || attempt.nextPoll > Date.now())
    return { connected: false };
  attempt.busy = true;
  attempt.nextPoll = Date.now() + attempt.interval * 1000;
  try {
    const response = await providerPost(
      `${issuer}/api/accounts/deviceauth/token`,
      JSON.stringify({
        device_auth_id: attempt.deviceId,
        user_code: attempt.code,
      }),
      'application/json',
    );
    if (response.status === 403 || response.status === 404)
      return { connected: false };
    if (!response.ok) throw new Error('Device authorization failed');
    const raw: unknown = await response.json();
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('authorization_code' in raw) ||
      typeof raw.authorization_code !== 'string' ||
      !('code_verifier' in raw) ||
      typeof raw.code_verifier !== 'string'
    )
      throw new Error('Invalid device response');
    attempts.delete(attemptId);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: raw.authorization_code,
      code_verifier: raw.code_verifier,
      redirect_uri: `${issuer}/deviceauth/callback`,
      client_id: clientId,
    });
    const exchange = await providerPost(
      `${issuer}/oauth/token`,
      body,
      'application/x-www-form-urlencoded',
    );
    if (!exchange.ok) throw new Error('Token exchange failed');
    const tokens = parseTokens(await exchange.json());
    await authorize();
    const result = await cloudDb
      .update(sharedCodexImageConnection)
      .set({ state: 'connected', encryptedTokens: encrypt(tokens) })
      .where(
        and(
          eq(sharedCodexImageConnection.id, sharedId),
          eq(sharedCodexImageConnection.generation, attempt.generation),
          eq(sharedCodexImageConnection.state, 'connecting'),
        ),
      )
      .returning({ userId: sharedCodexImageConnection.id });
    if (!result.length) throw new Error('Connection superseded');
    return { connected: true };
  } catch {
    attempts.delete(attemptId);
    throw createError({
      statusCode: 502,
      statusMessage: 'ChatGPT sign-in could not be completed. Start again.',
    });
  } finally {
    attempt.busy = false;
  }
}
export async function getConnection() {
  const [row] = await cloudDb
    .select()
    .from(sharedCodexImageConnection)
    .where(eq(sharedCodexImageConnection.id, sharedId));
  if (!row || row.state !== 'connected' || !row.encryptedTokens)
    throw createError({
      statusCode: 401,
      statusMessage:
        'An administrator must connect or reconnect ChatGPT to generate a spine.',
    });
  let tokens: Tokens;
  try {
    tokens = decrypt(row.encryptedTokens);
  } catch {
    throw createError({
      statusCode: 401,
      statusMessage:
        'ChatGPT connection could not be read. Reconnect to continue.',
    });
  }
  if (tokens.expiresAt > Date.now() + 120_000)
    return { accessToken: tokens.accessToken, generation: row.generation };
  const claimed = await cloudDb
    .update(sharedCodexImageConnection)
    .set({ state: 'refreshing', encryptedTokens: null })
    .where(
      and(
        eq(sharedCodexImageConnection.id, sharedId),
        eq(sharedCodexImageConnection.generation, row.generation),
        eq(sharedCodexImageConnection.state, 'connected'),
      ),
    )
    .returning({ userId: sharedCodexImageConnection.id });
  if (!claimed.length)
    throw createError({
      statusCode: 409,
      statusMessage: 'ChatGPT connection is changing. Try again.',
    });
  try {
    const response = await providerPost(
      `${issuer}/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: clientId,
      }),
      'application/x-www-form-urlencoded',
    );
    if (!response.ok) throw new Error('Refresh failed');
    tokens = parseTokens(await response.json(), tokens.refreshToken);
    const updated = await cloudDb
      .update(sharedCodexImageConnection)
      .set({ state: 'connected', encryptedTokens: encrypt(tokens) })
      .where(
        and(
          eq(sharedCodexImageConnection.id, sharedId),
          eq(sharedCodexImageConnection.generation, row.generation),
          eq(sharedCodexImageConnection.state, 'refreshing'),
        ),
      )
      .returning({ userId: sharedCodexImageConnection.id });
    if (!updated.length) throw new Error('Connection superseded');
    return { accessToken: tokens.accessToken, generation: row.generation };
  } catch {
    throw createError({
      statusCode: 401,
      statusMessage:
        'ChatGPT connection needs to be renewed. Reconnect to continue.',
    });
  }
}
export async function isCurrentConnection(generation: string) {
  const [row] = await cloudDb
    .select({
      generation: sharedCodexImageConnection.generation,
      state: sharedCodexImageConnection.state,
    })
    .from(sharedCodexImageConnection)
    .where(eq(sharedCodexImageConnection.id, sharedId));
  return row?.generation === generation && row.state === 'connected';
}
