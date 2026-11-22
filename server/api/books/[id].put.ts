import { auth } from '~~/server/utils/auth';
import {
  updateBookMetadata,
  type PutBookBody,
} from '~~/server/utils/books/update-metadata';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const id = getRouterParam(event, 'id');
  if (!id)
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  const body = (await readBody(event)) as PutBookBody | null;
  if (!body || typeof body !== 'object')
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing request body',
    });
  const result = await updateBookMetadata({
    userId: session.user.id,
    id,
    body,
  });
  return result.storageWarning ? result : { success: true };
});
