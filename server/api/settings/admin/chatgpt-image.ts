import { auth } from '~/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import { assertCollectionAdmin } from '~~/server/utils/collections/model';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';
import {
  connectionStatus,
  disconnect,
  pollConnection,
  startConnection,
} from '~~/server/utils/codex-image/connection';

export default defineEventHandler(async (event) => {
  if (
    event.method !== 'GET' &&
    ['cross-site', 'same-site'].includes(
      getHeader(event, 'sec-fetch-site') ?? '',
    )
  )
    throw createError({
      statusCode: 403,
      statusMessage: 'Cross-site requests are not allowed.',
    });
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({
      statusCode: 401,
      statusMessage: 'Sign in to Delb first.',
    });
  await assertCollectionAdmin(cloudDb, session.user.id);
  setHeader(event, 'Cache-Control', 'private, no-store');
  setHeader(event, 'Vary', 'Cookie');
  if (event.method === 'GET') return await connectionStatus();
  if (event.method === 'DELETE') {
    await disconnect();
    return { connected: false };
  }
  if (event.method !== 'POST')
    throw createError({
      statusCode: 405,
      statusMessage: 'Method not allowed.',
    });
  await cacheBoundedRequestBody(event.node.req, event.node.res, 4096);
  const body: unknown = await readBody(event);
  if (!body || typeof body !== 'object' || !('action' in body))
    throw createError({ statusCode: 400, statusMessage: 'Invalid request.' });
  const authorize = async () => {
    const current = await auth.api.getSession({ headers: event.headers });
    if (!current || current.session.id !== session.session.id)
      throw new Error('Session expired');
    await assertCollectionAdmin(cloudDb, session.user.id);
  };
  if (body.action === 'start')
    return await startConnection(
      session.user.id,
      session.session.id,
      authorize,
    );
  if (
    body.action === 'poll' &&
    'attemptId' in body &&
    typeof body.attemptId === 'string'
  )
    return await pollConnection(
      session.user.id,
      session.session.id,
      body.attemptId,
      authorize,
    );
  throw createError({ statusCode: 400, statusMessage: 'Invalid request.' });
});
