import { eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionMembers, users } from '~/utils/db/schema';
import {
  collectionActor,
  requiredCollectionId,
} from '~~/server/utils/collections/http';
import { assertCollectionManager } from '~~/server/utils/collections/model';
export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const id = requiredCollectionId(event);
  await assertCollectionManager(cloudDb, actor.id, id);
  const members = await cloudDb
    .select({
      userId: users.id,
      email: users.email,
      role: collectionMembers.role,
    })
    .from(collectionMembers)
    .innerJoin(users, eq(users.id, collectionMembers.userId))
    .where(eq(collectionMembers.collectionId, id));
  return { success: true, data: { members } };
});
