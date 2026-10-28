import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commitCoverUpdate,
  recoverPendingCoverUpdates,
} from './cover-update-transaction.ts';

test('commits all staged cover files after the database update', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-'));
  const bookDir = path.join(root, 'book');
  await mkdir(bookDir);
  const first = path.join(bookDir, 'one.epub');
  const second = path.join(bookDir, 'two.epub');
  await writeFile(first, 'old-one');
  await writeFile(second, 'old-two');
  let databaseValue: string | null = null;

  const result = await commitCoverUpdate({
    operationParent: bookDir,
    allowedRoot: root,
    previousCoverImagePath: null,
    expectedCoverImagePath: 'library/book/thumb.webp',
    files: [
      { targetPath: first, data: new TextEncoder().encode('new-one') },
      { targetPath: second, data: new TextEncoder().encode('new-two') },
    ],
    commitDatabase: async () => {
      databaseValue = 'library/book/thumb.webp';
    },
    rollbackDatabase: async () => {
      databaseValue = null;
    },
  });

  assert.equal(await readFile(first, 'utf8'), 'new-one');
  assert.equal(await readFile(second, 'utf8'), 'new-two');
  assert.equal(databaseValue, 'library/book/thumb.webp');
  assert.deepEqual(result.backupFallbackPaths, []);
});

test('uses a verified copy when a union filesystem rejects the backup rename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-'));
  const bookDir = path.join(root, 'book');
  await mkdir(bookDir);
  const target = path.join(bookDir, 'thumb.webp');
  await writeFile(target, 'old-thumbnail');

  const result = await commitCoverUpdate({
    operationParent: bookDir,
    allowedRoot: root,
    previousCoverImagePath: 'library/book/thumb.webp',
    expectedCoverImagePath: 'library/book/thumb.webp',
    files: [
      { targetPath: target, data: new TextEncoder().encode('new-thumbnail') },
    ],
    commitDatabase: async () => undefined,
    rollbackDatabase: async () => undefined,
    renameExistingToBackup: async () => {
      const error = new Error(
        'Unknown system error -117',
      ) as NodeJS.ErrnoException;
      error.errno = -117;
      error.code = 'Unknown system error -117';
      throw error;
    },
  });

  assert.equal(await readFile(target, 'utf8'), 'new-thumbnail');
  assert.deepEqual(result.backupFallbackPaths, [target]);
});

test('leaves original files unchanged when the database update fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-'));
  const bookDir = path.join(root, 'book');
  await mkdir(bookDir);
  const target = path.join(bookDir, 'book.epub');
  await writeFile(target, 'original');

  await assert.rejects(
    commitCoverUpdate({
      operationParent: bookDir,
      allowedRoot: root,
      previousCoverImagePath: null,
      expectedCoverImagePath: 'library/book/thumb.webp',
      files: [
        { targetPath: target, data: new TextEncoder().encode('replacement') },
      ],
      commitDatabase: async () => {
        throw new Error('database unavailable');
      },
      rollbackDatabase: async () => undefined,
    }),
    /database unavailable/,
  );
  assert.equal(await readFile(target, 'utf8'), 'original');
});

test('restores every original when a later file swap fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-'));
  const bookDir = path.join(root, 'book');
  await mkdir(bookDir);
  const first = path.join(bookDir, 'one.epub');
  const blockedParent = path.join(bookDir, 'not-a-directory');
  const second = path.join(blockedParent, 'two.epub');
  await writeFile(first, 'old-one');
  await writeFile(blockedParent, 'blocks mkdir');
  let databaseValue: string | null = null;

  await assert.rejects(
    commitCoverUpdate({
      operationParent: bookDir,
      allowedRoot: root,
      previousCoverImagePath: null,
      expectedCoverImagePath: 'library/book/thumb.webp',
      files: [
        { targetPath: first, data: new TextEncoder().encode('new-one') },
        { targetPath: second, data: new TextEncoder().encode('new-two') },
      ],
      commitDatabase: async () => {
        databaseValue = 'library/book/thumb.webp';
      },
      rollbackDatabase: async () => {
        databaseValue = null;
      },
    }),
  );

  assert.equal(await readFile(first, 'utf8'), 'old-one');
  assert.equal(await readFile(blockedParent, 'utf8'), 'blocks mkdir');
  assert.equal(databaseValue, null);
});

test('restores an original copied for backup when a later swap fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-'));
  const bookDir = path.join(root, 'book');
  await mkdir(bookDir);
  const first = path.join(bookDir, 'thumb.webp');
  const blockedParent = path.join(bookDir, 'not-a-directory');
  const second = path.join(blockedParent, 'book.epub');
  await writeFile(first, 'old-thumbnail');
  await writeFile(blockedParent, 'blocks mkdir');
  let databaseValue: string | null = null;

  await assert.rejects(
    commitCoverUpdate({
      operationParent: bookDir,
      allowedRoot: root,
      previousCoverImagePath: 'library/book/old-thumb.webp',
      expectedCoverImagePath: 'library/book/thumb.webp',
      files: [
        {
          targetPath: first,
          data: new TextEncoder().encode('new-thumbnail'),
        },
        { targetPath: second, data: new TextEncoder().encode('new-epub') },
      ],
      commitDatabase: async () => {
        databaseValue = 'library/book/thumb.webp';
      },
      rollbackDatabase: async () => {
        databaseValue = 'library/book/old-thumb.webp';
      },
      renameExistingToBackup: async () => {
        const error = new Error(
          'Unknown system error -117',
        ) as NodeJS.ErrnoException;
        error.errno = -117;
        error.code = 'Unknown system error -117';
        throw error;
      },
    }),
  );

  assert.equal(await readFile(first, 'utf8'), 'old-thumbnail');
  assert.equal(await readFile(blockedParent, 'utf8'), 'blocks mkdir');
  assert.equal(databaseValue, 'library/book/old-thumb.webp');
});

test('rolls a partially swapped committed operation forward during recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-'));
  const bookDir = path.join(root, 'book');
  const operationDir = path.join(bookDir, '.cover-update-interrupted');
  await mkdir(operationDir, { recursive: true });
  const first = path.join(bookDir, 'one.epub');
  const second = path.join(bookDir, 'two.epub');
  await writeFile(first, 'new-one');
  await writeFile(second, 'old-two');
  await writeFile(path.join(operationDir, 'old-0'), 'old-one');
  await writeFile(path.join(operationDir, 'new-1'), 'new-two');
  await writeFile(
    path.join(operationDir, 'journal.json'),
    JSON.stringify({
      version: 1,
      phase: 'database-committed',
      previousCoverImagePath: null,
      expectedCoverImagePath: 'library/book/thumb.webp',
      entries: [
        {
          targetPath: first,
          stagedName: 'new-0',
          backupName: 'old-0',
          hadOriginal: true,
        },
        {
          targetPath: second,
          stagedName: 'new-1',
          backupName: 'old-1',
          hadOriginal: true,
        },
      ],
    }),
  );

  await recoverPendingCoverUpdates({
    operationParent: bookDir,
    allowedRoot: root,
    currentCoverImagePath: 'library/book/thumb.webp',
  });
  assert.equal(await readFile(first, 'utf8'), 'new-one');
  assert.equal(await readFile(second, 'utf8'), 'new-two');
});

test('same-path recovery uses the committed database marker after interruption', async () => {
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: ':memory:' });
  await db.execute('CREATE TABLE decisions (id TEXT PRIMARY KEY)');
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-marker-'));
  const bookDir = path.join(root, 'book');
  await mkdir(bookDir);
  const target = path.join(bookDir, 'thumb.webp');
  await writeFile(target, 'old');
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
    await assert.rejects(
      commitCoverUpdate({
        operationParent: bookDir,
        allowedRoot: root,
        bookId: 'book',
        previousCoverImagePath: 'library/book/thumb.webp',
        expectedCoverImagePath: 'library/book/thumb.webp',
        files: [{ targetPath: target, data: Buffer.from('new') }],
        decision,
        commitDatabase: async (id) => {
          await db.execute({
            sql: 'INSERT INTO decisions VALUES (?)',
            args: [id],
          });
          throw new Error('interrupted after commit');
        },
        rollbackDatabase: async () => {
          throw new Error('must not roll back a committed decision');
        },
      }),
      /interrupted after commit/,
    );
    assert.equal(await readFile(target, 'utf8'), 'old');
    await recoverPendingCoverUpdates({
      operationParent: bookDir,
      allowedRoot: root,
      currentCoverImagePath: 'library/book/thumb.webp',
      bookId: 'book',
      decision,
    });
    assert.equal(await readFile(target, 'utf8'), 'new');
    assert.equal((await db.execute('SELECT id FROM decisions')).rows.length, 0);
  } finally {
    db.close();
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('retains an ambiguous legacy journal and refuses further recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-ambiguous-'));
  const operationDir = path.join(root, '.cover-update-ambiguous');
  await mkdir(operationDir);
  await writeFile(path.join(operationDir, 'old-0'), 'only backup');
  await writeFile(
    path.join(operationDir, 'journal.json'),
    JSON.stringify({
      version: 1,
      phase: 'prepared',
      previousCoverImagePath: 'same',
      expectedCoverImagePath: 'same',
      entries: [],
    }),
  );
  const { rm } = await import('node:fs/promises');
  try {
    await assert.rejects(
      recoverPendingCoverUpdates({
        operationParent: root,
        allowedRoot: root,
        currentCoverImagePath: 'same',
      }),
      /Ambiguous/,
    );
    assert.equal(
      await readFile(path.join(operationDir, 'old-0'), 'utf8'),
      'only backup',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery retains an unexpected cover target and its unique backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-conflict-'));
  const dir = path.join(root, '.cover-update-conflict');
  const target = path.join(root, 'book.epub');
  await mkdir(dir);
  await writeFile(target, 'unexpected');
  await writeFile(path.join(dir, 'new-0'), 'replacement');
  await writeFile(path.join(dir, 'old-0'), 'original');
  await writeFile(
    path.join(dir, 'journal.json'),
    JSON.stringify({
      version: 1,
      phase: 'database-committed',
      previousCoverImagePath: null,
      expectedCoverImagePath: 'thumb',
      entries: [
        {
          targetPath: target,
          stagedName: 'new-0',
          backupName: 'old-0',
          hadOriginal: true,
        },
      ],
    }),
  );
  const { rm } = await import('node:fs/promises');
  try {
    await assert.rejects(
      recoverPendingCoverUpdates({
        operationParent: root,
        allowedRoot: root,
        currentCoverImagePath: 'thumb',
      }),
      /unexpectedly exists/,
    );
    assert.equal(await readFile(target, 'utf8'), 'unexpected');
    assert.equal(await readFile(path.join(dir, 'old-0'), 'utf8'), 'original');
    assert.equal(
      await readFile(path.join(dir, 'new-0'), 'utf8'),
      'replacement',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('committed recovery completes an interrupted verified backup copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-cover-copy-crash-'));
  const dir = path.join(root, '.cover-update-interrupted-copy');
  const target = path.join(root, 'book.epub');
  await mkdir(dir);
  await writeFile(target, 'original');
  await writeFile(path.join(dir, 'old-0'), 'original');
  await writeFile(path.join(dir, 'new-0'), 'replacement');
  await writeFile(
    path.join(dir, 'journal.json'),
    JSON.stringify({
      version: 1,
      phase: 'database-committed',
      previousCoverImagePath: null,
      expectedCoverImagePath: 'thumb',
      entries: [
        {
          targetPath: target,
          stagedName: 'new-0',
          backupName: 'old-0',
          hadOriginal: true,
        },
      ],
    }),
  );
  try {
    await recoverPendingCoverUpdates({
      operationParent: root,
      allowedRoot: root,
      currentCoverImagePath: 'thumb',
    });
    assert.equal(await readFile(target, 'utf8'), 'replacement');
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});
