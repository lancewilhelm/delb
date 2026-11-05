import { cloudDb } from '~~/server/utils/db/cloud';
import { getDashboard } from '~~/server/utils/books/dashboard';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });

  const query = getQuery(event);
  const shelf = query.shelf ?? 'reading';
  if (shelf !== 'reading' && shelf !== 'recent') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid dashboard shelf',
    });
  }
  const collectionId = query.collectionId ?? '';
  if (typeof collectionId !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid collection id',
    });
  }
  const rawOffset = query.offset ?? '0';
  if (
    typeof rawOffset !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(rawOffset) ||
    !Number.isSafeInteger(Number(rawOffset))
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid shelf offset',
    });
  }

  try {
    return {
      success: true,
      data: await getDashboard(cloudDb, {
        userId: session.user.id,
        collectionId,
        shelf,
        offset: Number(rawOffset),
      }),
    };
  } catch (error) {
    logger.error(error, 'GET /api/dashboard: Failed to load shelf');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to load dashboard',
    });
  }
});
