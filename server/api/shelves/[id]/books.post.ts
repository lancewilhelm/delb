import { auth } from '~/utils/auth';
import { changeShelfBooks } from '~~/server/utils/shelves/model';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';
export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const id = getRouterParam(event, 'id');
  await cacheBoundedRequestBody(
    event.node.req,
    event.node.res,
    8 * 1024 * 1024,
  );
  const body: unknown = await readBody(event);
  if (
    !id ||
    !body ||
    typeof body !== 'object' ||
    !('bookIds' in body) ||
    !Array.isArray(body.bookIds) ||
    !body.bookIds.every((value: unknown) => typeof value === 'string') ||
    !('action' in body) ||
    (body.action !== 'add' && body.action !== 'remove')
  )
    throw createError({ statusCode: 400, statusMessage: 'Choose valid books' });
  return changeShelfBooks(session.user.id, id, body.bookIds, body.action);
});
