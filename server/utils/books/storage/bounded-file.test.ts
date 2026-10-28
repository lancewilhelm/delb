import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readBoundedFile } from './bounded-file';

test('bounded file reading accepts a small file and rejects an oversized file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-bounded-file-'));
  const file = path.join(root, 'input');
  try {
    await writeFile(file, '123456');
    assert.equal((await readBoundedFile(file, 6)).toString(), '123456');
    await assert.rejects(readBoundedFile(file, 5));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
