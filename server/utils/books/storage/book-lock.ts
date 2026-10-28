import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

type Owner = { host: string; pid: number; token: string };

function isOwner(value: unknown): value is Owner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Record<string, unknown>;
  return (
    typeof owner.host === 'string' &&
    Number.isSafeInteger(owner.pid) &&
    typeof owner.pid === 'number' &&
    owner.pid > 0 &&
    typeof owner.token === 'string'
  );
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export async function withBookStorageLock<T>(
  root: string,
  bookId: string,
  work: () => Promise<T>,
): Promise<T> {
  const lockRoot = path.join(root, '.delb-locks');
  const lockName = createHash('sha256').update(bookId).digest('hex');
  const lockDir = path.join(lockRoot, lockName);
  const owner: Owner = {
    host: hostname(),
    pid: process.pid,
    token: randomUUID(),
  };
  await mkdir(lockRoot, { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const reapDir = `${lockDir}.reap`;
    await mkdir(reapDir);
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(lockDir, 'owner.json'), 'utf8'),
      );
      if (
        !isOwner(parsed) ||
        parsed.host !== hostname() ||
        !isDead(parsed.pid)
      ) {
        throw new Error('Book storage is locked or its owner is ambiguous');
      }
      const stale = `${lockDir}.stale-${randomUUID()}`;
      await rename(lockDir, stale);
      await mkdir(lockDir);
      await rm(stale, { recursive: true });
    } finally {
      await rm(reapDir, { recursive: true });
    }
  }
  try {
    await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(owner), {
      flag: 'wx',
    });
    return await work();
  } finally {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(lockDir, 'owner.json'), 'utf8'),
    );
    if (isOwner(parsed) && parsed.token === owner.token)
      await rm(lockDir, { recursive: true });
  }
}
