import { auth } from '~~/server/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import { assertBookEditor } from '~~/server/utils/collections/model';
import { connectionStatus } from '~~/server/utils/codex-image/connection';

export default defineEventHandler(async (event) => {
  if (event.method !== 'GET')
    throw createError({
      statusCode: 405,
      statusMessage: 'Method not allowed.',
    });
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const id = getRouterParam(event, 'id');
  if (!id)
    throw createError({ statusCode: 400, statusMessage: 'Missing book.' });
  await assertBookEditor(cloudDb, session.user.id, id);
  setHeader(event, 'Cache-Control', 'private, no-store');
  setHeader(event, 'Vary', 'Cookie');
  return { connected: (await connectionStatus()).connected };
});
