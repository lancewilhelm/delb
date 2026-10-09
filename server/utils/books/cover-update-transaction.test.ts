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
