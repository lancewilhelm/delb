import { eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { users } from '~/utils/db/schema';
import { collectionActor } from '~~/server/utils/collections/http';
import {
  assertAccountDeletionAllowed,
  assertCollectionAdmin,
  lockCollectionChanges,
  CollectionError,
} from '~~/server/utils/collections/model';

export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const body = await readBody<{ id?: unknown }>(event);
  if (typeof body?.id !== 'string' || !body.id.trim())
    throw new CollectionError(400, 'User id is required');
  const id = body.id;
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    await assertCollectionAdmin(tx, actor.id);
    await assertAccountDeletionAllowed(tx, id);
    const deleted = await tx
      .delete(users)
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!deleted.length) throw new CollectionError(404, 'User not found');
    return { success: true };
  });
});
