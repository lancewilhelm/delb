import { auth } from '~~/server/utils/auth';
import { saveCollectionShelf } from '~~/server/utils/bookshelf/collection';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';

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
  await cacheBoundedRequestBody(
    event.node.req,
    event.node.res,
    16 * 1024 * 1024,
  );
  const body: unknown = await readBody(event);
  if (
    !body ||
    typeof body !== 'object' ||
    !('revision' in body) ||
    typeof body.revision !== 'number' ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0 ||
    !('token' in body) ||
    typeof body.token !== 'string' ||
    !('arrangement' in body)
  )
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid bookshelf request',
    });
  setHeader(event, 'Cache-Control', 'private, no-store');
  return saveCollectionShelf(
    session.user.id,
    id,
    body.revision,
    body.token,
    body.arrangement,
  );
});
