import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { moveStoredFiles, recoverStoredMoves } from './move-operation';

test('move preserves collisions and recovers committed copies after interruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-move-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const db = createClient({ url: ':memory:' });
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
  const entries = [{ source, destination }];
  try {
    await writeFile(source, 'original');
    await writeFile(destination, 'unrelated');
    await assert.rejects(
      moveStoredFiles({
        root,
        bookId: 'book',
        entries,
        decision,
        commit: async () => undefined,
      }),
      /already exists/,
    );
    assert.equal(await readFile(source, 'utf8'), 'original');
    assert.equal(await readFile(destination, 'utf8'), 'unrelated');
    await rm(destination);
    await assert.rejects(
      moveStoredFiles({
        root,
        bookId: 'book',
        entries,
        decision,
        commit: async (id) => {
          await db.execute({
            sql: 'INSERT INTO decisions VALUES (?)',
            args: [id],
          });
          throw new Error('interrupted after commit');
        },
      }),
      /interrupted after commit/,
    );
    assert.equal(await readFile(source, 'utf8'), 'original');
    await recoverStoredMoves({
      root,
      decision,
      withLock: async (_id, work) => await work(),
    });
    await assert.rejects(readFile(source), { code: 'ENOENT' });
    assert.equal(await readFile(destination, 'utf8'), 'original');
    assert.equal((await db.execute('SELECT * FROM decisions')).rows.length, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('uncommitted copies and originals are retained for inspection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-move-failed-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const decision = {
    isCommitted: async () => false,
    remove: async () => undefined,
  };
  try {
    await writeFile(source, 'original');
    await assert.rejects(
      moveStoredFiles({
        root,
        bookId: 'book',
        entries: [{ source, destination }],
        decision,
        commit: async () => {
          throw new Error('database failed');
        },
      }),
      /database failed/,
    );
    await assert.rejects(
      recoverStoredMoves({
        root,
        decision,
        withLock: async (_id, work) => await work(),
      }),
      /requires inspection/,
    );
    assert.equal(await readFile(source, 'utf8'), 'original');
    assert.equal(await readFile(destination, 'utf8'), 'original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
