import { eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { books, collections } from '~/utils/db/schema';
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
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    const collection = await assertCollectionManager(tx, actor.id, id, true);
    if (collection.isDefault)
      throw new CollectionError(
        409,
        'Choose a replacement default before deleting this collection',
      );
    const contents = await tx
      .select({ id: books.id })
      .from(books)
      .where(eq(books.collectionId, id))
      .limit(1);
    if (contents.length)
      throw new CollectionError(
        409,
        'Move or delete the books before deleting this collection',
      );
    await tx.delete(collections).where(eq(collections.id, id));
    return { success: true, data: { deleted: true, id } };
  });
});
