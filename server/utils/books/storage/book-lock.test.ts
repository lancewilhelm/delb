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
    let signalHeld!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const first = withBookStorageLock(
      root,
      'book',
      async () => {
        signalHeld();
        await held;
      },
      db,
    );
    await firstHeld;
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

test('a second process waits for a live SQLite owner and reclaims its row after death', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { pathToFileURL } = await import('node:url');
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-lock-process-'));
  const dbUrl = `file:${path.join(root, 'locks.db')}`;
  const db = createClient({ url: dbUrl });
  await db.execute(
    'CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  const moduleUrl = pathToFileURL(
    path.resolve('server/utils/books/storage/book-lock.ts'),
  ).href;
  const script = `import { createClient } from '@libsql/client'; import { withBookStorageLock } from ${JSON.stringify(moduleUrl)}; const db = createClient({url:${JSON.stringify(dbUrl)}}); await withBookStorageLock(${JSON.stringify(root)}, 'book', async () => { process.stdout.write('held'); process.stdin.resume(); await new Promise(() => {}); }, db);`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    const [data] = await once(child.stdout, 'data');
    assert.equal(String(data), 'held');
    let entered = false;
    const next = withBookStorageLock(
      root,
      'book',
      async () => {
        entered = true;
      },
      db,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(entered, false);
    child.kill('SIGKILL');
    await once(child, 'exit');
    await next;
    assert.equal(entered, true);
    assert.equal(
      (await db.execute('SELECT * FROM system_state')).rows.length,
      0,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
