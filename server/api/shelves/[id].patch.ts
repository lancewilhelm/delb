import { auth } from '~~/server/utils/auth';
import { renameShelf } from '~~/server/utils/shelves/model';
export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const id = getRouterParam(event, 'id');
  const body: unknown = await readBody(event);
  if (
    !id ||
    !body ||
    typeof body !== 'object' ||
    !('name' in body) ||
    typeof body.name !== 'string'
  )
    throw createError({
      statusCode: 400,
      statusMessage: 'Shelf name required',
    });
  await renameShelf(session.user.id, id, body.name);
  return { success: true };
});
