import { and, eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionMembers, collections } from '~/utils/db/schema';
import {
  collectionActor,
  requiredCollectionId,
} from '~~/server/utils/collections/http';
import {
  lockCollectionChanges,
  CollectionError,
} from '~~/server/utils/collections/model';
export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const id = requiredCollectionId(event);
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    const [collection] = await tx
      .select()
      .from(collections)
      .where(eq(collections.id, id));
    if (!collection) throw new CollectionError(404, 'Collection not found');
    if (collection.ownerUserId === actor.id)
      throw new CollectionError(
        400,
        'Transfer ownership before leaving this collection',
      );
    const removed = await tx
      .delete(collectionMembers)
      .where(
        and(
          eq(collectionMembers.collectionId, id),
          eq(collectionMembers.userId, actor.id),
        ),
      )
      .returning();
    return { success: true, data: { left: removed.length > 0 } };
  });
});
