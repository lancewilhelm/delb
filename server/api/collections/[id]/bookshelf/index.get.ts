import { auth } from '~~/server/utils/auth';
import { readCollectionShelf } from '~~/server/utils/bookshelf/collection';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const id = getRouterParam(event, 'id');
  if (!id)
    throw createError({
      statusCode: 400,
      statusMessage: 'Collection is required',
    });
  setHeader(event, 'Cache-Control', 'private, no-store');
  return readCollectionShelf(session.user.id, id);
});
