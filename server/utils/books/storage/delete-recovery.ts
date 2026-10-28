import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { storageOperations } from '~/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { withBookStorageLock } from './book-lock';
import { recoverStoredDeletes } from './delete-operation';

export const deleteDecision = {
  isCommitted: async (id: string) =>
    (
      await cloudDb
        .select({ id: storageOperations.id })
        .from(storageOperations)
        .where(
          and(
            eq(storageOperations.id, id),
            inArray(storageOperations.kind, ['delete', 'replace']),
          ),
        )
        .limit(1)
    ).length > 0,
  remove: async (id: string) => {
    await cloudDb
      .delete(storageOperations)
      .where(
        and(
          eq(storageOperations.id, id),
          inArray(storageOperations.kind, ['delete', 'replace']),
        ),
      );
  },
};

export async function recoverBookDeletes(): Promise<void> {
  const root = path.resolve(process.cwd(), 'library');
  await recoverStoredDeletes({
    root,
    decision: deleteDecision,
    withLock: async (bookId, work) =>
      await withBookStorageLock(root, bookId, work),
  });
}
