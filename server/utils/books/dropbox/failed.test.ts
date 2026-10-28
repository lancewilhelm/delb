import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { moveToFailed } from './failed';

test('same-name failures at the same time retain both distinct inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-dropbox-failed-'));
  const failedDirAbs = path.join(root, 'failed');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const now = new Date('2026-01-01T00:00:00Z');
  try {
    await writeFile(first, 'first bytes');
    await writeFile(second, 'second bytes');
    await Promise.all(
      [first, second].map(
        async (fileAbs) =>
          await moveToFailed({
            failedDirAbs,
            fileAbs,
            originalFilename: 'book.epub',
            reason: 'failure',
            now,
          }),
      ),
    );
    const files = (await readdir(failedDirAbs)).filter((file) =>
      file.endsWith('.epub'),
    );
    assert.equal(files.length, 2);
    assert.deepEqual(
      (
        await Promise.all(
          files.map(
            async (file) =>
              await readFile(path.join(failedDirAbs, file), 'utf8'),
          ),
        )
      ).sort(),
      ['first bytes', 'second bytes'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
