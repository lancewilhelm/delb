import { auth } from '~~/server/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import { assertBookEditor } from '~~/server/utils/collections/model';
import { findSeriesSpines } from '~~/server/utils/books/series-spine-references';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const bookId = getRouterParam(event, 'id');
  if (!bookId)
    throw createError({ statusCode: 400, statusMessage: 'Missing book.' });
  await assertBookEditor(cloudDb, session.user.id, bookId);
  const rows = await findSeriesSpines(session.user.id, bookId);
  setHeader(event, 'Cache-Control', 'private, no-store');
  setHeader(event, 'Vary', 'Cookie');
  return rows.map(({ bookId: id, title, seriesIndex, revision }) => ({
    bookId: id,
    title,
    seriesIndex,
    revision,
  }));
});
