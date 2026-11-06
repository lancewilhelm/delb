import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionActor } from '~~/server/utils/collections/http';
import {
  moveCollectionBooks,
  CollectionError,
} from '~~/server/utils/collections/model';

export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const body = await readBody<{
    bookIds?: unknown;
    targetCollectionId?: unknown;
    expectedSources?: unknown;
    confirmed?: unknown;
  }>(event);
  const input = body?.bookIds;
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 10000 ||
    input.some((id: unknown) => typeof id !== 'string' || !id.trim()) ||
    typeof body.targetCollectionId !== 'string' ||
    body.confirmed !== true ||
    !Array.isArray(body.expectedSources)
  )
    throw new CollectionError(
      400,
      'Choose one destination and confirm the move',
    );
  const ids = [...new Set(input.map((id: string) => id.trim()))];
  const expected: Record<string, string> = {};
  for (const source of body.expectedSources) {
    if (
      !source ||
      typeof source !== 'object' ||
      !('bookId' in source) ||
      typeof source.bookId !== 'string' ||
      !('collectionId' in source) ||
      typeof source.collectionId !== 'string' ||
      Object.hasOwn(expected, source.bookId)
    )
      throw new CollectionError(400, 'Invalid source selection');
    expected[source.bookId] = source.collectionId;
  }
  if (
    Object.keys(expected).length !== ids.length ||
    ids.some((id) => !Object.hasOwn(expected, id))
  )
    throw new CollectionError(400, 'Review the source selection again');
  const moved = await moveCollectionBooks(
    cloudDb,
    actor.id,
    ids,
    body.targetCollectionId,
    expected,
  );
  return { success: true, data: { moved } };
});
