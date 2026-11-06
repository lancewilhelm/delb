import { eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collections, users } from '~/utils/db/schema';
import {
  collectionActor,
  requiredCollectionId,
  memberEmail,
} from '~~/server/utils/collections/http';
import {
  assertCollectionManager,
  lockCollectionChanges,
  CollectionError,
} from '~~/server/utils/collections/model';
export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const id = requiredCollectionId(event);
  const body = await readBody<{ email?: unknown }>(event);
  const email = memberEmail(body?.email);
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    await assertCollectionManager(tx, actor.id, id, true);
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (!target) throw new CollectionError(404, 'User not found');
    await tx
      .update(collections)
      .set({ ownerUserId: target.id, updatedAt: new Date() })
      .where(eq(collections.id, id));
    return { success: true, data: { ownerUserId: target.id } };
  });
});
