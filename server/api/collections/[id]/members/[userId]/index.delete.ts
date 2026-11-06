import { and, eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionMembers } from '~/utils/db/schema';
import {
  collectionActor,
  requiredCollectionId,
} from '~~/server/utils/collections/http';
import {
  assertCollectionManager,
  lockCollectionChanges,
  CollectionError,
} from '~~/server/utils/collections/model';
export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const id = requiredCollectionId(event);
  const targetId = event.context.params?.userId;
  if (!targetId) throw new CollectionError(400, 'User id is required');
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    const collection = await assertCollectionManager(tx, actor.id, id);
    if (targetId === collection.ownerUserId)
      throw new CollectionError(
        400,
        'Transfer ownership before removing the owner',
      );
    if (targetId === actor.id)
      throw new CollectionError(
        400,
        'Use Leave collection to remove your own membership',
      );
    const removed = await tx
      .delete(collectionMembers)
      .where(
        and(
          eq(collectionMembers.collectionId, id),
          eq(collectionMembers.userId, targetId),
        ),
      )
      .returning();
    return { success: true, data: { removed: removed.length > 0 } };
  });
});
