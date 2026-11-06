import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import {
  finishCommittedDropboxClaim,
  retainDropboxClaimTarget,
  readDropboxClaimTarget,
  removeDropboxClaimTarget,
} from './claim';

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

test('a resumed claim retains its destination and refuses missing or ambiguous plans', async () => {
  const client = createClient({ url: ':memory:' });
  const db = drizzle(client);
  await client.execute(
    'CREATE TABLE system_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  );
  try {
    const original = { ownerUserId: 'importer', collectionIds: ['original'] };
    assert.deepEqual(
      await retainDropboxClaimTarget(db, 'first', original),
      original,
    );
    // A restarted batch with a changed default must not redirect an existing claim.
    assert.deepEqual(
      await retainDropboxClaimTarget(db, 'first', {
        ownerUserId: 'importer',
        collectionIds: ['new-default'],
      }),
      original,
    );
    assert.deepEqual(await readDropboxClaimTarget(db, 'first'), original);
    await assert.rejects(
      readDropboxClaimTarget(db, 'unrecorded'),
      /retained destination/,
    );
    await client.execute({
      sql: 'INSERT INTO system_state VALUES(?,?)',
      args: [
        'dropbox-claim:ambiguous',
        JSON.stringify({
          ownerUserId: 'importer',
          collectionIds: ['one', 'two'],
        }),
      ],
    });
    await assert.rejects(
      readDropboxClaimTarget(db, 'ambiguous'),
      /retained destination/,
    );
    await removeDropboxClaimTarget(db, 'first');
    await assert.rejects(
      readDropboxClaimTarget(db, 'first'),
      /retained destination/,
    );
  } finally {
    client.close();
  }
});
