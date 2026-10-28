import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { storageOperations } from '~/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { withBookStorageLock } from './book-lock';
import { recoverStoredMoves } from './move-operation';

export const moveDecision = {
  isCommitted: async (id: string) =>
    (
      await cloudDb
        .select({ id: storageOperations.id })
        .from(storageOperations)
        .where(
          and(eq(storageOperations.id, id), eq(storageOperations.kind, 'move')),
        )
        .limit(1)
    ).length > 0,
  remove: async (id: string) => {
    await cloudDb
      .delete(storageOperations)
      .where(
        and(eq(storageOperations.id, id), eq(storageOperations.kind, 'move')),
      );
  },
};
export async function recoverBookMoves(): Promise<void> {
  const root = path.resolve(process.cwd(), 'library');
  await recoverStoredMoves({
    root,
    decision: moveDecision,
    withLock: async (bookId, work) =>
      await withBookStorageLock(root, bookId, work),
  });
}
