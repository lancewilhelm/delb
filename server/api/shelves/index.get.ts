import { auth } from '~~/server/utils/auth';
import { listShelves } from '~~/server/utils/shelves/model';
export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  setHeader(event, 'Cache-Control', 'private, no-store');
  return {
    success: true,
    data: { shelves: await listShelves(session.user.id) },
  };
});
