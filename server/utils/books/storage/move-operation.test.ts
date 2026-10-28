import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('matching uncommitted copies are rolled back', async () => {
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
    await recoverStoredMoves({
      root,
      decision,
      withLock: async (_id, work) => await work(),
    });
    assert.equal(await readFile(source, 'utf8'), 'original');
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a killed writer recovers its committed move on restart', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { pathToFileURL } = await import('node:url');
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-move-kill-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const dbUrl = `file:${path.join(root, 'test.db')}`;
  const db = createClient({ url: dbUrl });
  await db.execute('CREATE TABLE decisions (id TEXT PRIMARY KEY)');
  await writeFile(source, 'original');
  const moduleUrl = pathToFileURL(
    path.resolve('server/utils/books/storage/move-operation.ts'),
  ).href;
  const script = `import { createClient } from '@libsql/client'; import { moveStoredFiles } from ${JSON.stringify(moduleUrl)}; const db = createClient({ url: ${JSON.stringify(dbUrl)} }); const decision = { isCommitted: async id => (await db.execute({sql:'SELECT id FROM decisions WHERE id=?', args:[id]})).rows.length > 0, remove: async id => { await db.execute({sql:'DELETE FROM decisions WHERE id=?', args:[id]}); } }; await moveStoredFiles({ root: ${JSON.stringify(root)}, bookId: 'book', entries: [{source:${JSON.stringify(source)}, destination:${JSON.stringify(destination)}}], decision, commit: async id => { await db.execute({sql:'INSERT INTO decisions VALUES (?)',args:[id]}); process.stdout.write('committed'); process.stdin.resume(); await new Promise(() => {}); } });`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { stdio: ['pipe', 'pipe', 'pipe'] },
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
    const [data] = await once(child.stdout, 'data');
    assert.equal(String(data), 'committed');
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.equal(await readFile(source, 'utf8'), 'original');
    await recoverStoredMoves({
      root,
      decision,
      withLock: async (_id, work) => await work(),
    });
    assert.equal(await readFile(destination, 'utf8'), 'original');
    await assert.rejects(readFile(source), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery refuses to discard a committed journal when destination is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-move-missing-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  let committed = false;
  const decision = {
    isCommitted: async () => committed,
    remove: async () => {
      committed = false;
    },
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
          committed = true;
          throw new Error('interrupted');
        },
      }),
      /interrupted/,
    );
    await rm(destination);
    await assert.rejects(
      recoverStoredMoves({
        root,
        decision,
        withLock: async (_id, work) => await work(),
      }),
      /destination is missing/,
    );
    assert.equal(await readFile(source, 'utf8'), 'original');
    assert.equal(committed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const copy of ['ori', 'different bytes'])
  test(`recovery retains an uncommitted destination containing ${copy}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'delb-move-changed-'));
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
            throw new Error('interrupted');
          },
        }),
      );
      await writeFile(destination, copy);
      const warnings = await recoverStoredMoves({
        root,
        decision,
        withLock: async (_id, work) => await work(),
      });
      assert.equal(await readFile(source, 'utf8'), 'original');
      assert.equal(await readFile(destination, 'utf8'), copy);
      const names = await readdir(root);
      const failed = names.find((name) =>
        name.startsWith('.delb-failed-move-'),
      );
      assert.ok(failed);
      const journal = names.find((name) => name.startsWith('.delb-move-'));
      assert.ok(journal);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.journalDir, path.join(root, journal));
      assert.equal(warnings[0]?.marker, path.join(root, failed));
      assert.deepEqual(warnings[0]?.entries, [{ source, destination }]);
      await rm(source);
      await rm(destination);
      assert.deepEqual(
        await recoverStoredMoves({
          root,
          decision,
          withLock: async (_id, work) => await work(),
        }),
        warnings,
      );
      assert.equal(
        await readFile(path.join(root, journal, 'retained-source-0'), 'utf8'),
        'original',
      );
      assert.equal(
        await readFile(
          path.join(root, journal, 'retained-destination-0'),
          'utf8',
        ),
        copy,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('legacy markers acquire retained copies before later mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-move-legacy-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const decision = {
    isCommitted: async () => false,
    remove: async () => undefined,
  };
  const recover = () =>
    recoverStoredMoves({
      root,
      decision,
      withLock: async (_id, work) => await work(),
    });
  try {
    await writeFile(source, 'original');
    await assert.rejects(
      moveStoredFiles({
        root,
        bookId: 'book',
        entries: [{ source, destination }],
        decision,
        commit: async () => {
          throw new Error('interrupted');
        },
      }),
    );
    await writeFile(destination, 'conflict');
    const [warning] = await recover();
    assert.ok(warning);
    await rm(path.join(warning.journalDir, 'retained-source-0'));
    await rm(path.join(warning.journalDir, 'retained-destination-0'));
    await writeFile(warning.marker, '');
    await recover();
    await rm(source);
    await rm(destination);
    assert.equal((await recover()).length, 1);
    assert.equal(
      await readFile(
        path.join(warning.journalDir, 'retained-source-0'),
        'utf8',
      ),
      'original',
    );
    assert.equal(
      await readFile(
        path.join(warning.journalDir, 'retained-destination-0'),
        'utf8',
      ),
      'conflict',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unmarked uncommitted moves still reject missing originals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-move-no-original-'));
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
          throw new Error('interrupted');
        },
      }),
    );
    await rm(source);
    await assert.rejects(
      recoverStoredMoves({
        root,
        decision,
        withLock: async (_id, work) => await work(),
      }),
      /Uncommitted move source is missing/,
    );
    assert.equal(await readFile(destination, 'utf8'), 'original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
