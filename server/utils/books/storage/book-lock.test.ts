import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { withBookStorageLock } from './book-lock';

test('SQLite serializes owners across root aliases and reaps dead owners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-lock-'));
  const db = createClient({ url: `file:${path.join(root, 'locks.db')}` });
  const second = createClient({ url: `file:${path.join(root, 'locks.db')}` });
  try {
    await db.execute(
      'CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const first = withBookStorageLock(
      root,
      'book',
      async () => {
        await held;
      },
      db,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = withBookStorageLock(
      '/another-alias',
      'book',
      async () => {
        entered = true;
      },
      second,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(entered, false);
    release();
    await Promise.all([first, next]);
    assert.equal(entered, true);
    await db.execute({
      sql: 'INSERT INTO system_state VALUES (?, ?)',
      args: [
        'storage-lock:book',
        JSON.stringify({ host: os.hostname(), pid: 2147483647, token: 'old' }),
      ],
    });
    assert.equal(
      await withBookStorageLock(root, 'book', async () => 'recovered', second),
      'recovered',
    );
    await db.execute({
      sql: 'INSERT INTO system_state VALUES (?, ?)',
      args: [
        'storage-lock:book',
        JSON.stringify({ host: 'foreign', pid: 1, token: 'old' }),
      ],
    });
    await assert.rejects(
      withBookStorageLock(root, 'book', async () => undefined, db),
      /another host/,
    );
  } finally {
    db.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});
