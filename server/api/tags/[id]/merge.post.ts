import { auth } from '~/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';
import { mutateTag, TagMutationError } from '~~/server/utils/tags/mutate';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  if (session.user.role !== 'admin' && session.user.role !== 'owner')
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  const sourceId = getRouterParam(event, 'id');
  const body: unknown = await readBody(event);
  const targetId =
    typeof body === 'object' &&
    body !== null &&
    'targetId' in body &&
    typeof body.targetId === 'string'
      ? body.targetId.trim()
      : '';
  if (!sourceId || !targetId)
    throw createError({
      statusCode: 400,
      statusMessage: 'Source and destination are required',
    });
  try {
    await mutateTag(cloudDb, session.user.id, {
      kind: 'merge',
      sourceId,
      targetId,
    });
    return { success: true, data: { targetId } };
  } catch (error) {
    if (error instanceof TagMutationError)
      throw createError({
        statusCode: error.statusCode,
        statusMessage: error.message,
      });
    throw error;
  }
});
