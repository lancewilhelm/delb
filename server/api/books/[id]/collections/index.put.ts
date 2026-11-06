import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionActor } from '~~/server/utils/collections/http';
import {
  moveCollectionBooks,
  CollectionError,
} from '~~/server/utils/collections/model';

export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const bookId = getRouterParam(event, 'id');
  const body = await readBody<{
    collectionId?: unknown;
    sourceCollectionId?: unknown;
    confirmed?: unknown;
  }>(event);
  if (
    !bookId ||
    typeof body?.collectionId !== 'string' ||
    typeof body.sourceCollectionId !== 'string' ||
    body.confirmed !== true
  )
    throw new CollectionError(
      400,
      'Choose one destination and confirm the source collection access change',
    );
  await moveCollectionBooks(
    cloudDb,
    actor.id,
    [bookId],
    body.collectionId,
    body.sourceCollectionId,
  );
  return { success: true, data: { collectionId: body.collectionId, moved: 1 } };
});
