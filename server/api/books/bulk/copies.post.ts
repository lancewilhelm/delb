import { and, inArray, sql } from 'drizzle-orm';
import { books, collectionMembers } from '~/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionActor } from '~~/server/utils/collections/http';

export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const body = await readBody<unknown>(event);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid copy update',
    });
  const input = body as Record<string, unknown>;
  if (
    !Array.isArray(input.bookIds) ||
    !input.bookIds.length ||
    input.bookIds.some((id: unknown) => typeof id !== 'string' || !id.trim()) ||
    (input.physical !== undefined && typeof input.physical !== 'boolean') ||
    (input.audiobook !== undefined && typeof input.audiobook !== 'boolean') ||
    (input.physical === undefined && input.audiobook === undefined)
  )
    throw createError({
      statusCode: 400,
      statusMessage: 'Choose books and at least one copy change',
    });
  const ids = [...new Set(input.bookIds as string[])];
  const changes: { hasPhysicalCopy?: boolean; hasAudiobookCopy?: boolean } = {};
  if (typeof input.physical === 'boolean')
    changes.hasPhysicalCopy = input.physical;
  if (typeof input.audiobook === 'boolean')
    changes.hasAudiobookCopy = input.audiobook;
  const updated = await cloudDb.transaction(async (tx) => {
    let count = 0;
    for (let offset = 0; offset < ids.length; offset += 400) {
      const rows = await tx
        .update(books)
        .set(changes)
        .where(
          and(
            inArray(books.id, ids.slice(offset, offset + 400)),
            sql`EXISTS (SELECT 1 FROM ${collectionMembers} WHERE ${collectionMembers.collectionId} = ${books.collectionId} AND ${collectionMembers.userId} = ${actor.id} AND ${collectionMembers.role} IN ('owner', 'editor'))`,
          ),
        )
        .returning({ id: books.id });
      count += rows.length;
    }
    return count;
  });
  return { success: true, data: { updated, skipped: ids.length - updated } };
});
