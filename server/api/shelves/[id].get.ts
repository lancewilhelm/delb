import { auth } from '~/utils/auth';
import { readShelf } from '~~/server/utils/shelves/model';
export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const id = getRouterParam(event, 'id');
  if (!id)
    throw createError({ statusCode: 400, statusMessage: 'Shelf required' });
  setHeader(event, 'Cache-Control', 'private, no-store');
  return readShelf(session.user.id, id);
});
