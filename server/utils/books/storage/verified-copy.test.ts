import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyVerifiedExclusive } from './verified-copy';

test('verified copy preserves the source and rejects an existing destination', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'delb-copy-'));
  try {
    const source = path.join(dir, 'source');
    const destination = path.join(dir, 'destination');
    await writeFile(source, 'original');
    await copyVerifiedExclusive(source, destination);
    assert.equal(await readFile(source, 'utf8'), 'original');
    assert.equal(await readFile(destination, 'utf8'), 'original');
    await writeFile(source, 'different');
    await assert.rejects(copyVerifiedExclusive(source, destination), {
      code: 'EEXIST',
    });
    assert.equal(await readFile(source, 'utf8'), 'different');
    assert.equal(await readFile(destination, 'utf8'), 'original');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
