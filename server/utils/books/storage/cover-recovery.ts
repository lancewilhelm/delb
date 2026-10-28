import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { books, bookFiles, storageOperations } from '~/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { recoverPendingCoverUpdates } from '~~/server/utils/books/cover-update-transaction';
import { withBookStorageLock } from './book-lock';

export async function recoverBookCovers(): Promise<void> {
  const root = path.resolve(process.cwd(), 'library');
  const [bookRows, fileRows] = await Promise.all([
    cloudDb.select({ id: books.id, cover: books.coverImagePath }).from(books),
    cloudDb
      .select({ id: bookFiles.bookId, file: bookFiles.relativePath })
      .from(bookFiles),
  ]);
  const owners = new Map<string, Set<string>>();
  for (const { id, file } of [
    ...fileRows,
    ...bookRows.map((row) => ({ id: row.id, file: row.cover })),
  ]) {
    if (!file) continue;
    const dir = path.dirname(path.resolve(process.cwd(), file));
    const set = owners.get(dir) ?? new Set<string>();
    set.add(id);
    owners.set(dir, set);
  }
  const pending = new Map<string, Set<string>>();
  async function scan(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name.startsWith('.cover-update-')) {
        const journal: unknown = JSON.parse(
          await readFile(path.join(child, 'journal.json'), 'utf8'),
        );
        if (!journal || typeof journal !== 'object' || !('version' in journal))
          throw new Error(`Invalid cover journal: ${child}`);
        let bookId: string;
        if (
          journal.version === 2 &&
          'bookId' in journal &&
          typeof journal.bookId === 'string'
        ) {
          bookId = journal.bookId;
        } else if (journal.version === 1 && owners.get(dir)?.size === 1) {
          bookId = [...owners.get(dir)!][0]!;
        } else {
          throw new Error(`Ambiguous cover journal owner: ${child}`);
        }
        const ids = pending.get(dir) ?? new Set<string>();
        ids.add(bookId);
        pending.set(dir, ids);
      } else if (!entry.name.startsWith('.delb-')) {
        await scan(child);
      }
    }
  }
  await scan(root);
  for (const [dir, ids] of pending) {
    if (ids.size > 1 && owners.get(dir)?.size !== 1)
      throw new Error(`Ambiguous shared cover journal directory: ${dir}`);
    for (const bookId of ids) {
      await withBookStorageLock(root, bookId, async () => {
        const current = await cloudDb
          .select({ cover: books.coverImagePath })
          .from(books)
          .where(eq(books.id, bookId))
          .limit(1);
        const decision = {
          isCommitted: async (id: string) =>
            (
              await cloudDb
                .select({ id: storageOperations.id })
                .from(storageOperations)
                .where(
                  and(
                    eq(storageOperations.id, id),
                    eq(storageOperations.bookId, bookId),
                    eq(storageOperations.kind, 'cover'),
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
                  eq(storageOperations.bookId, bookId),
                  eq(storageOperations.kind, 'cover'),
                ),
              );
          },
        };
        await recoverPendingCoverUpdates({
          operationParent: dir,
          allowedRoot: root,
          currentCoverImagePath: current[0]?.cover ?? null,
          bookId,
          decision,
        });
      });
    }
  }
}
