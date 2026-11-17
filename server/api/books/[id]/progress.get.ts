import { auth } from '~/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  ProgressError,
  readReadingProgress,
} from '~~/server/utils/books/progress';

function calendarDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const bookId = getRouterParam(event, 'id');
  if (!bookId)
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });

  try {
    const progress = await readReadingProgress(cloudDb, {
      userId: session.user.id,
      bookId,
      limit: 51,
    });
    const display = (entry: NonNullable<typeof progress.latest>) => ({
      progressPercent: entry.progressPercent,
      pageNumber: entry.pageNumber,
      source: entry.source,
      occurredDate: calendarDate(entry.occurredAt),
    });
    setResponseHeader(event, 'Cache-Control', 'private, no-store');
    setResponseHeader(event, 'Vary', 'Cookie');
    return {
      success: true,
      data: {
        latest: progress.latest ? display(progress.latest) : null,
        history: progress.history
          .slice(0, 50)
          .map((entry) => ({ id: entry.id, ...display(entry) })),
        hasMore: progress.history.length > 50,
      },
    };
  } catch (error) {
    if (error instanceof ProgressError)
      throw createError({
        statusCode: error.statusCode,
        statusMessage: error.message,
      });
    throw error;
  }
});
