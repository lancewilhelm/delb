import { and, asc, eq } from 'drizzle-orm';
import {
  books,
  collectionMembers,
  personalShelfBooks,
  personalShelves,
} from '~~/server/utils/db/schema';
import { auth } from '~~/server/utils/auth';
import { cloudDb } from '~~/server/utils/db/cloud';

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const bookId = getRouterParam(event, 'id');
  if (!bookId)
    throw createError({ statusCode: 400, statusMessage: 'Missing book.' });
  const [book] = await cloudDb
    .select({ id: books.id })
    .from(books)
    .innerJoin(
      collectionMembers,
      and(
        eq(collectionMembers.collectionId, books.collectionId),
        eq(collectionMembers.userId, session.user.id),
      ),
    )
    .where(eq(books.id, bookId))
    .limit(1);
  if (!book)
    throw createError({ statusCode: 404, statusMessage: 'Book not found' });
  const rows = await cloudDb
    .select({
      id: personalShelves.id,
      name: personalShelves.name,
      member: personalShelfBooks.bookId,
    })
    .from(personalShelves)
    .leftJoin(
      personalShelfBooks,
      and(
        eq(personalShelfBooks.shelfId, personalShelves.id),
        eq(personalShelfBooks.bookId, bookId),
      ),
    )
    .where(eq(personalShelves.ownerId, session.user.id))
    .orderBy(asc(personalShelves.createdAt), asc(personalShelves.id));
  setHeader(event, 'Cache-Control', 'private, no-store');
  setHeader(event, 'Vary', 'Cookie');
  return rows.map(({ id, name, member }) => ({
    id,
    name,
    containsBook: member !== null,
  }));
});
