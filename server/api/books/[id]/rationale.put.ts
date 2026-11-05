import { auth } from '~/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import { writeRationale } from '~~/server/utils/books/tbr';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const bookId = getRouterParam(event, 'id');
  if (!bookId)
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  const body: unknown = await readBody(event);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('rationale' in body) ||
    typeof body.rationale !== 'string' ||
    body.rationale.length > 10000
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Rationale must be text of at most 10,000 characters.',
    });
  }
  const rationale = await writeRationale(
    cloudDb,
    session.user.id,
    bookId,
    body.rationale.trim(),
  );
  return { success: true, data: { rationale } };
});
