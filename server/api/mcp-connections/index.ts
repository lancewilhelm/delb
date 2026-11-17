import { auth } from '~/utils/auth';
import {
  createConnection,
  listConnections,
  revokeConnection,
} from '~~/server/utils/mcp/connections';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (event.method !== 'GET') {
    const origin = getHeader(event, 'origin');
    if (
      !origin ||
      origin !== getRequestURL(event).origin ||
      ['cross-site', 'same-site'].includes(
        getHeader(event, 'sec-fetch-site') ?? '',
      )
    )
      throw createError({
        statusCode: 403,
        statusMessage: 'Same-origin request required.',
      });
  }
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session || session.session.impersonatedBy)
    throw createError({
      statusCode: 401,
      statusMessage: 'Sign in to manage connections.',
    });
  if (event.method === 'GET') return listConnections(session.user.id);
  if (event.method !== 'POST' && event.method !== 'DELETE')
    throw createError({
      statusCode: 405,
      statusMessage: 'Method not allowed.',
    });
  await cacheBoundedRequestBody(event.node.req, event.node.res, 4096);
  const body: unknown = await readBody(event);
  if (!body || typeof body !== 'object')
    throw createError({ statusCode: 400, statusMessage: 'Invalid request.' });
  if (event.method === 'DELETE') {
    if (!('id' in body) || typeof body.id !== 'string' || body.id.length > 128)
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid connection.',
      });
    await revokeConnection(session.user.id, body.id);
    return { success: true };
  }
  if (
    !('name' in body) ||
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    body.name.trim().length > 80 ||
    !('canWrite' in body) ||
    typeof body.canWrite !== 'boolean'
  )
    throw createError({
      statusCode: 400,
      statusMessage: 'Enter a name and select access.',
    });
  return createConnection(session.user.id, body.name.trim(), body.canWrite);
});
