import { and, eq, inArray } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { books, collectionMembers, collections } from '~/utils/db/schema';
import { collectionActor } from '~~/server/utils/collections/http';
import { CollectionError } from '~~/server/utils/collections/model';

export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const body = await readBody<{ bookIds?: unknown }>(event);
  const input = body?.bookIds;
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 10000 ||
    input.some((id: unknown) => typeof id !== 'string' || !id.trim())
  )
    throw new CollectionError(400, 'Choose books to move');
  const ids = [...new Set(input.map((id: string) => id.trim()))];
  const sources = await cloudDb
    .select({
      bookId: books.id,
      collectionId: books.collectionId,
      name: collections.name,
      role: collectionMembers.role,
    })
    .from(books)
    .innerJoin(collections, eq(collections.id, books.collectionId))
    .innerJoin(
      collectionMembers,
      and(
        eq(collectionMembers.collectionId, books.collectionId),
        eq(collectionMembers.userId, actor.id),
      ),
    )
    .where(inArray(books.id, ids));
  if (sources.length !== ids.length)
    throw new CollectionError(
      404,
      'One or more selected books are no longer accessible',
    );
  return { success: true, data: { sources } };
});
