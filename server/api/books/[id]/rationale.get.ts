import { auth } from '~/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import { readRationale } from '~~/server/utils/books/tbr';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const bookId = getRouterParam(event, 'id');
  if (!bookId)
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  return {
    success: true,
    data: { rationale: await readRationale(cloudDb, session.user.id, bookId) },
  };
});
