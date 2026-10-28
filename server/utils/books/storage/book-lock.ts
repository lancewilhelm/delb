import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, LibsqlError, type Transaction } from '@libsql/client';

// Keep ownership alive even when the pending work promise is otherwise unreachable.
const activeTransactions = new Set<Transaction>();

export class BookStorageLockBusyError extends Error {}

export async function withBookStorageLock<T>(
  root: string,
  bookId: string,
  work: () => Promise<T>,
): Promise<T> {
  const directory = path.join(root, '.delb-locks');
  await mkdir(directory, { recursive: true });
  const name = createHash('sha256').update(bookId).digest('hex');
  const db = createClient({
    url: pathToFileURL(path.join(directory, `${name}.db`)).href,
  });
  try {
    await db.execute('PRAGMA busy_timeout=0');
    const deadline = Date.now() + 30000;
    for (;;) {
      let transaction;
      try {
        transaction = await db.transaction('write');
      } catch (error) {
        if (!(error instanceof LibsqlError) || error.code !== 'SQLITE_BUSY')
          throw error;
        if (Date.now() >= deadline)
          throw new BookStorageLockBusyError('Book storage lock is busy');
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      activeTransactions.add(transaction);
      try {
        let result: T;
        try {
          result = await work();
        } catch (error) {
          try {
            await transaction.rollback();
          } catch {
            // Preserve the original work error if rollback also fails.
          }
          throw error;
        }
        await transaction.rollback();
        return result;
      } finally {
        activeTransactions.delete(transaction);
      }
    }
  } finally {
    db.close();
  }
}
