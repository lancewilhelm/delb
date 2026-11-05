import { auth } from '~/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import { getTbrQueue } from '~~/server/utils/books/tbr';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  return { success: true, data: await getTbrQueue(cloudDb, session.user.id) };
});
