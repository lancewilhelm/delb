import { cloudDb } from '~~/server/utils/db/cloud';
import { setBookFavorite } from '~~/server/utils/books/dashboard';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const bookId = getRouterParam(event, 'id');
  if (!bookId)
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  const body: unknown = await readBody(event).catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('favorite' in body) ||
    typeof body.favorite !== 'boolean'
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'favorite must be a boolean',
    });
  }
  let result;
  try {
    result = await setBookFavorite(cloudDb, {
      userId: session.user.id,
      bookId,
      favorite: body.favorite,
    });
  } catch (error) {
    logger.error(error, 'PUT /api/books/:id/favorite: Failed to save favorite');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to save favorite',
    });
  }
  if (!result)
    throw createError({ statusCode: 404, statusMessage: 'Book not found' });
  return { success: true, data: result };
});
