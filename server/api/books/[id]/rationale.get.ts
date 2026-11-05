import { auth } from '~/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import { readRationale } from '~~/server/utils/books/tbr';
import { parseBookId, parseReaderId } from '~~/server/utils/books/ids';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const bookId = parseBookId(getRouterParam(event, 'id'));
  return {
    success: true,
    data: {
      rationale: await readRationale(cloudDb, {
        userId: parseReaderId(session.user.id),
        bookId,
      }),
    },
  };
});
