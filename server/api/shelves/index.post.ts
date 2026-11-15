import { auth } from '~/utils/auth';
import { createShelf } from '~~/server/utils/shelves/model';
export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const body: unknown = await readBody(event);
  if (
    !body ||
    typeof body !== 'object' ||
    !('name' in body) ||
    typeof body.name !== 'string'
  )
    throw createError({
      statusCode: 400,
      statusMessage: 'Shelf name required',
    });
  return { success: true, data: await createShelf(session.user.id, body.name) };
});
