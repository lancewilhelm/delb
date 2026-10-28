import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { LibsqlError } from '@libsql/client';
import { withBookStorageLock } from './book-lock';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('same book waits across root aliases while another book proceeds', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'delb-lock-'));
  const root = path.join(parent, 'library');
  await mkdir(root);
  const alias = path.join(parent, 'alias');
  await symlink(root, alias);
  let release!: () => void;
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  try {
    const first = withBookStorageLock(root, 'book', async () => {
      signalHeld();
      await held;
    });
    await acquired;
    let entered = false;
    const next = withBookStorageLock(alias, 'book', async () => {
      entered = true;
    });
    assert.equal(
      await withBookStorageLock(root, 'other', async () => 'other'),
      'other',
    );
    await delay(150);
    assert.equal(entered, false);
    release();
    await Promise.all([first, next]);
    assert.equal(entered, true);
    await assert.rejects(
      withBookStorageLock(root, 'book', async () => {
        throw new Error('work failed');
      }),
      /work failed/,
    );
    assert.equal(
      await withBookStorageLock(root, 'book', async () => 'released'),
      'released',
    );
    let attempts = 0;
    await assert.rejects(
      withBookStorageLock(root, 'book', async () => {
        attempts++;
        throw new LibsqlError('work failed', 'SQLITE_BUSY');
      }),
      /work failed/,
    );
    assert.equal(attempts, 1);
  } finally {
    release();
    await rm(parent, { recursive: true, force: true });
  }
});

test('a process waits for a live owner and acquires after it is killed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-lock-process-'));
  const moduleUrl = pathToFileURL(
    path.resolve('server/utils/books/storage/book-lock.ts'),
  ).href;
  const script = `import { withBookStorageLock } from ${JSON.stringify(moduleUrl)}; await withBookStorageLock(${JSON.stringify(root)}, 'book', async () => { process.stdout.write('held'); process.stdin.resume(); await new Promise(() => {}); });`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    const [data] = await once(child.stdout, 'data');
    assert.equal(String(data), 'held');
    let entered = false;
    const next = withBookStorageLock(root, 'book', async () => {
      entered = true;
    });
    await delay(150);
    assert.equal(entered, false);
    child.kill('SIGKILL');
    await once(child, 'exit');
    await next;
    assert.equal(entered, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
