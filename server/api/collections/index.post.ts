import { and, eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collections } from '~/utils/db/schema';
import {
  collectionActor,
  collectionName,
} from '~~/server/utils/collections/http';
import { lockCollectionChanges } from '~~/server/utils/collections/model';
export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const body = await readBody<{ name?: unknown }>(event);
  const name = collectionName(body?.name);
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    const [existing] = await tx
      .select({ id: collections.id })
      .from(collections)
      .where(
        and(eq(collections.ownerUserId, actor.id), eq(collections.name, name)),
      );
    if (existing)
      return {
        success: true,
        data: { collection: { id: existing.id, name }, created: false },
      };
    const [collection] = await tx
      .insert(collections)
      .values({
        id: crypto.randomUUID(),
        name,
        ownerUserId: actor.id,
        isPersonal: false,
      })
      .returning();
    return { success: true, data: { collection, created: true } };
  });
});
