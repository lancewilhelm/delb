import { and, eq } from 'drizzle-orm';
import { auth } from '~/utils/auth';
import { userBookshelves } from '~/utils/db/schema';
import { parseBookshelf } from '~~/shared/bookshelf';
import { cloudDb } from '~~/server/utils/db/cloud';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
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
    !('arrangement' in body) ||
    typeof body.revision !== 'number' ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid bookshelf revision',
    });
  }
  const arrangement = parseBookshelf(body.arrangement);
  if (!arrangement)
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid bookshelf arrangement',
    });
  const revision = body.revision + 1;
  const rows =
    body.revision === 0
      ? await cloudDb
          .insert(userBookshelves)
          .values({ userId: session.user.id, revision, arrangement })
          .onConflictDoNothing()
          .returning({ revision: userBookshelves.revision })
      : await cloudDb
          .update(userBookshelves)
          .set({ revision, arrangement })
          .where(
            and(
              eq(userBookshelves.userId, session.user.id),
              eq(userBookshelves.revision, body.revision),
            ),
          )
          .returning({ revision: userBookshelves.revision });
  if (!rows.length)
    throw createError({
      statusCode: 409,
      statusMessage: 'A newer bookshelf arrangement exists',
    });
  setHeader(event, 'Cache-Control', 'private, no-store');
  return { revision };
});
