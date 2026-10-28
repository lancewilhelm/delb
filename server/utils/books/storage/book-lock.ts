import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createClient, type Client } from '@libsql/client';

type Owner = { host: string; pid: number; token: string };
const client = createClient({
  url: process.env.DATABASE_URL || 'file:./data/delb.db',
});

function parseOwner(value: string): Owner {
  const owner: unknown = JSON.parse(value);
  if (
    !owner ||
    typeof owner !== 'object' ||
    !('host' in owner) ||
    typeof owner.host !== 'string' ||
    !('pid' in owner) ||
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !('token' in owner) ||
    typeof owner.token !== 'string'
  )
    throw new Error('Ambiguous book storage lock');
  return { host: owner.host, pid: owner.pid, token: owner.token };
}
function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
export class BookStorageLockBusyError extends Error {}

export async function withBookStorageLock<T>(
  _root: string,
  bookId: string,
  work: () => Promise<T>,
  db: Client = client,
): Promise<T> {
  const key = `storage-lock:${bookId}`;
  const owner: Owner = {
    host: hostname(),
    pid: process.pid,
    token: randomUUID(),
  };
  const value = JSON.stringify(owner);
  const deadline = Date.now() + 30000;
  for (;;) {
    const inserted = await db.execute({
      sql: 'INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
      args: [key, value],
    });
    if (inserted.rowsAffected === 1) break;
    const found = await db.execute({
      sql: 'SELECT value FROM system_state WHERE key = ?',
      args: [key],
    });
    if (!found.rows.length) continue;
    const previous = String(found.rows[0]!.value);
    const current = parseOwner(previous);
    if (current.host !== owner.host)
      throw new Error('Book storage lock belongs to another host');
    if (isDead(current.pid)) {
      const claimed = await db.execute({
        sql: 'UPDATE system_state SET value = ? WHERE key = ? AND value = ?',
        args: [value, key, previous],
      });
      if (claimed.rowsAffected === 1) break;
      continue;
    }
    if (Date.now() >= deadline)
      throw new BookStorageLockBusyError('Book storage lock is busy');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    return await work();
  } finally {
    await db.execute({
      sql: 'DELETE FROM system_state WHERE key = ? AND value = ?',
      args: [key, value],
    });
  }
}
