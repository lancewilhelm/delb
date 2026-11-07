import path from 'node:path';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  collectionActor,
  requiredCollectionId,
} from '~~/server/utils/collections/http';
import { CollectionError } from '~~/server/utils/collections/model';
import { deleteCollection } from '~~/server/utils/collections/delete';
export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const id = requiredCollectionId(event);
  const body = await readBody<{
    confirmationName?: unknown;
    deleteBooks?: unknown;
  }>(event);
  if (typeof body?.confirmationName !== 'string' || body.deleteBooks !== true)
    throw new CollectionError(
      400,
      'Confirm deletion of the collection and its books with the collection name',
    );
  const result = await deleteCollection({
    db: cloudDb,
    libraryRoot: path.resolve(process.cwd(), 'library'),
    userId: actor.id,
    collectionId: id,
    confirmationName: body.confirmationName,
  });
  return { success: true, data: { deleted: true, id, ...result } };
});
