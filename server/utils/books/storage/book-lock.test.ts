import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withBookStorageLock } from './book-lock';

test('rejects concurrent owners and recovers a dead same-host owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-lock-'));
  try {
    await withBookStorageLock(root, 'book', async () => {
      await assert.rejects(
        withBookStorageLock(root, 'book', async () => undefined),
      );
    });
    const lock = path.join(
      root,
      '.delb-locks',
      createHash('sha256').update('book').digest('hex'),
    );
    await mkdir(lock);
    await writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({ host: os.hostname(), pid: 2147483647, token: 'old' }),
    );
    assert.equal(
      await withBookStorageLock(root, 'book', async () => 'recovered'),
      'recovered',
    );
    await mkdir(lock);
    await writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({ host: 'foreign-host', pid: 2147483647, token: 'old' }),
    );
    await assert.rejects(
      withBookStorageLock(root, 'book', async () => undefined),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
