import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { finishCommittedDropboxClaim } from './claim';

test('committed claim is retained until its library copy verifies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-claim-'));
  const input = path.join(root, 'claim');
  const destination = path.join(root, 'book');
  const db = createClient({ url: ':memory:' });
  await db.execute('CREATE TABLE decisions (id TEXT PRIMARY KEY)');
  await db.execute("INSERT INTO decisions VALUES ('claim')");
  const removeDecision = async () => {
    await db.execute("DELETE FROM decisions WHERE id = 'claim'");
  };
  try {
    await writeFile(input, 'original');
    await writeFile(destination, 'different');
    await assert.rejects(
      finishCommittedDropboxClaim({ input, destination, removeDecision }),
      /cannot be verified/,
    );
    assert.equal(await readFile(input, 'utf8'), 'original');
    assert.equal((await db.execute('SELECT * FROM decisions')).rows.length, 1);
    await writeFile(destination, 'original');
    await finishCommittedDropboxClaim({ input, destination, removeDecision });
    await assert.rejects(readFile(input), { code: 'ENOENT' });
    assert.equal((await db.execute('SELECT * FROM decisions')).rows.length, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
