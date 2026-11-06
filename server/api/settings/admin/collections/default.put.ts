import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionActor } from '~~/server/utils/collections/http';
import {
  changeDefaultCollection,
  CollectionError,
} from '~~/server/utils/collections/model';

export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const body = await readBody<{ collectionId?: unknown }>(event);
  if (typeof body?.collectionId !== 'string' || !body.collectionId.trim())
    throw new CollectionError(400, 'Choose a collection');
  await changeDefaultCollection(cloudDb, actor.id, body.collectionId);
  return { success: true };
});
