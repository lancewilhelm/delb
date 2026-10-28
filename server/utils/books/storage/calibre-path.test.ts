import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { confinedCalibrePath } from './calibre-path';

test('rejects traversal and symlinks outside the Calibre library', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'delb-calibre-'));
  try {
    const root = path.join(dir, 'calibre');
    await mkdir(root);
    await writeFile(path.join(root, 'book.epub'), 'book');
    await writeFile(path.join(dir, 'private'), 'private');
    await symlink(path.join(dir, 'private'), path.join(root, 'escape'));
    assert.equal(
      await confinedCalibrePath(root, 'book.epub'),
      await realpath(path.join(root, 'book.epub')),
    );
    await assert.rejects(confinedCalibrePath(root, '../private'));
    await assert.rejects(confinedCalibrePath(root, path.join(dir, 'private')));
    await assert.rejects(confinedCalibrePath(root, 'escape'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
