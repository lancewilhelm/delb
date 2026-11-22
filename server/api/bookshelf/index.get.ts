import { eq } from 'drizzle-orm';
import { auth } from '~~/server/utils/auth';
import { userBookshelves } from '~~/server/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  setHeader(event, 'Cache-Control', 'private, no-store');
  const [row] = await cloudDb
    .select()
    .from(userBookshelves)
    .where(eq(userBookshelves.userId, session.user.id))
    .limit(1);
  return {
    revision: row?.revision ?? 0,
    arrangement: row?.arrangement ?? null,
  };
});
