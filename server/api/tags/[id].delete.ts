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
  if (!sourceId)
    throw createError({ statusCode: 400, statusMessage: 'Missing tag id' });
  try {
    await mutateTag(cloudDb, session.user.id, { kind: 'delete', sourceId });
    return { success: true };
  } catch (error) {
    if (error instanceof TagMutationError)
      throw createError({
        statusCode: error.statusCode,
        statusMessage: error.message,
      });
    throw error;
  }
});
