import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { beginStoredCreate, recoverStoredCreates } from './create-operation';

test('uncommitted upload bytes are preserved and committed upload stays visible after recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-create-'));
  const db = createClient({ url: `file:${path.join(root, 'test.db')}` });
  await db.execute('CREATE TABLE decisions (id TEXT PRIMARY KEY)');
  const decision = {
    isCommitted: async (id: string) =>
      (
        await db.execute({
          sql: 'SELECT id FROM decisions WHERE id = ?',
          args: [id],
        })
      ).rows.length > 0,
    remove: async (id: string) => {
      await db.execute({
        sql: 'DELETE FROM decisions WHERE id = ?',
        args: [id],
      });
    },
  };
  const recover = async () =>
    await recoverStoredCreates({
      root,
      decision,
      withLock: async (_id, work) => await work(),
    });
  try {
    const directory = path.join(root, 'first');
    const file = path.join(directory, 'book.epub');
    const first = await beginStoredCreate({
      root,
      bookId: 'first',
      directory,
      file,
      decision,
    });
    await writeFile(file, 'failed input');
    await recover();
    const recovery = path.join(root, `.delb-failed-create-${first.id}`);
    assert.equal(
      await readFile(path.join(recovery, 'files', 'book.epub'), 'utf8'),
      'failed input',
    );
    assert.ok((await readdir(recovery)).includes('journal'));
    const secondDirectory = path.join(root, 'second');
    const secondFile = path.join(secondDirectory, 'book.epub');
    const second = await beginStoredCreate({
      root,
      bookId: 'second',
      directory: secondDirectory,
      file: secondFile,
      decision,
    });
    await writeFile(secondFile, 'committed input');
    await db.execute({
      sql: 'INSERT INTO decisions VALUES (?)',
      args: [second.id],
    });
    await recover();
    assert.equal(await readFile(secondFile, 'utf8'), 'committed input');
    assert.equal((await db.execute('SELECT id FROM decisions')).rows.length, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
