import { eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionMembers, users } from '~/utils/db/schema';
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
  const body = await readBody<{ email?: unknown; role?: unknown }>(event);
  const email = memberEmail(body?.email);
  const role = body?.role;
  if (role !== 'editor' && role !== 'viewer')
    throw new CollectionError(400, 'Choose editor or viewer');
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    const collection = await assertCollectionManager(tx, actor.id, id);
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (!target) throw new CollectionError(404, 'User not found');
    if (target.id === actor.id)
      throw new CollectionError(400, 'You cannot change your own role');
    if (target.id === collection.ownerUserId)
      throw new CollectionError(
        400,
        'Use ownership transfer to change the owner',
      );
    await tx
      .insert(collectionMembers)
      .values({ collectionId: id, userId: target.id, role })
      .onConflictDoUpdate({
        target: [collectionMembers.collectionId, collectionMembers.userId],
        set: { role },
      });
    return { success: true, data: { member: { userId: target.id, role } } };
  });
});
