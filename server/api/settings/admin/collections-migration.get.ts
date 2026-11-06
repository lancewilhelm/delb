import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionActor } from '~~/server/utils/collections/http';
import { assertCollectionAdmin } from '~~/server/utils/collections/model';
import { previewCollectionMigration } from '~~/server/utils/collections/migration';

export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  await assertCollectionAdmin(cloudDb, actor.id);
  return { success: true, data: await previewCollectionMigration(cloudDb) };
});
