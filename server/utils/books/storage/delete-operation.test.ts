import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deleteStoredFiles, recoverStoredDeletes } from './delete-operation';

test('deletion retains original on rollback and completes after a committed interruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-delete-'));
  const file = path.join(root, 'book.epub');
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
  const recover = async () =>
    await recoverStoredDeletes({
      root,
      decision,
      withLock: async (_id, work) => await work(),
    });
  try {
    await writeFile(file, 'original');
    await assert.rejects(
      deleteStoredFiles({
        root,
        bookId: 'book',
        sources: [file],
        decision,
        commit: async () => {
          throw new Error('database failed');
        },
      }),
      /database failed/,
    );
    await recover();
    assert.equal(await readFile(file, 'utf8'), 'original');
    await assert.rejects(
      deleteStoredFiles({
        root,
        bookId: 'book',
        sources: [file],
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
    assert.equal(await readFile(file, 'utf8'), 'original');
    await recover();
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal((await db.execute('SELECT id FROM decisions')).rows.length, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery retains the backup when a committed source changed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-delete-changed-'));
  const file = path.join(root, 'book.epub');
  const committed = new Set<string>();
  const decision = {
    isCommitted: async (id: string) => committed.has(id),
    remove: async (id: string) => {
      committed.delete(id);
    },
  };
  try {
    await writeFile(file, 'original');
    await assert.rejects(
      deleteStoredFiles({
        root,
        bookId: 'book',
        sources: [file],
        decision,
        commit: async (id) => {
          committed.add(id);
          await writeFile(file, 'different');
        },
      }),
      /source changed/,
    );
    await assert.rejects(
      recoverStoredDeletes({
        root,
        decision,
        withLock: async (_id, work) => await work(),
      }),
      /source changed/,
    );
    assert.equal(await readFile(file, 'utf8'), 'different');
    const { readdir } = await import('node:fs/promises');
    const journalDir = (await readdir(root)).find((name) =>
      name.startsWith('.delb-delete-'),
    );
    assert.ok(journalDir);
    assert.equal(
      await readFile(path.join(root, journalDir, '0'), 'utf8'),
      'original',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replacement decision and file row commit together before retiring old bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-replace-'));
  const old = path.join(root, 'old.epub');
  const replacement = path.join(root, 'new.epub');
  const db = createClient({ url: `file:${path.join(root, 'test.db')}` });
  await db.executeMultiple(
    "CREATE TABLE decisions (id TEXT PRIMARY KEY); CREATE TABLE books (path TEXT); INSERT INTO books VALUES ('old.epub');",
  );
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
  try {
    await writeFile(old, 'old bytes');
    await writeFile(replacement, 'new bytes');
    await assert.rejects(
      deleteStoredFiles({
        root,
        bookId: 'book',
        sources: [old],
        decision,
        commit: async (id) => {
          const tx = await db.transaction('write');
          try {
            await tx.execute({
              sql: 'INSERT INTO decisions VALUES (?)',
              args: [id],
            });
            await tx.execute("UPDATE books SET path = 'new.epub'");
            await tx.commit();
          } finally {
            tx.close();
          }
          throw new Error('interrupted');
        },
      }),
      /interrupted/,
    );
    assert.equal(
      (await db.execute('SELECT path FROM books')).rows[0]?.path,
      'new.epub',
    );
    assert.equal(await readFile(old, 'utf8'), 'old bytes');
    await recoverStoredDeletes({
      root,
      decision,
      withLock: async (_id, work) => await work(),
    });
    await assert.rejects(readFile(old), { code: 'ENOENT' });
    assert.equal(await readFile(replacement, 'utf8'), 'new bytes');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
