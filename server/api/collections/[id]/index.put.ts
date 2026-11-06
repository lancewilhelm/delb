import { eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collections } from '~/utils/db/schema';
import {
  collectionActor,
  requiredCollectionId,
  collectionName,
} from '~~/server/utils/collections/http';
import {
  assertCollectionManager,
  lockCollectionChanges,
} from '~~/server/utils/collections/model';
export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const id = requiredCollectionId(event);
  const body = await readBody<{ name?: unknown }>(event);
  const name = collectionName(body?.name);
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    await assertCollectionManager(tx, actor.id, id);
    await tx
      .update(collections)
      .set({ name, updatedAt: new Date() })
      .where(eq(collections.id, id));
    return { success: true, data: { collection: { id, name } } };
  });
});
