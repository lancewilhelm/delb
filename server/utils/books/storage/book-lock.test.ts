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

test('a separate live process owns the lock until it dies', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { pathToFileURL } = await import('node:url');
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-lock-process-'));
  const moduleUrl = pathToFileURL(
    path.resolve('server/utils/books/storage/book-lock.ts'),
  ).href;
  const script = `import { withBookStorageLock } from ${JSON.stringify(moduleUrl)}; await withBookStorageLock(${JSON.stringify(root)}, 'book', async () => { process.stdout.write('locked'); process.stdin.resume(); await new Promise(() => {}); });`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    const [data] = await once(child.stdout, 'data');
    assert.equal(String(data), 'locked');
    await assert.rejects(
      withBookStorageLock(root, 'book', async () => undefined),
    );
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.equal(
      await withBookStorageLock(root, 'book', async () => 'recovered'),
      'recovered',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
