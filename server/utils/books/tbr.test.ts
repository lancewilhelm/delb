import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { getTbrQueue, readRationale, writeRationale } from './tbr';
import { transitionBookStatuses } from './status-transition';
import { parseBookId, parseReaderId } from './ids';

const readerId = parseReaderId('reader');
const otherId = parseReaderId('other');
const bookA = parseBookId('a');
const bookB = parseBookId('b');

async function fixture({ legacy = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'delb-tbr-'));
  const client = createClient({ url: `file:${join(directory, 'test.db')}` });
  const db = drizzle(client);
  let migrationsFolder = '.drizzle/migrations';
  const journal = JSON.parse(
    readFileSync('.drizzle/migrations/meta/_journal.json', 'utf8'),
  );
  if (legacy) {
    migrationsFolder = join(directory, 'legacy-migrations');
    cpSync('.drizzle/migrations', migrationsFolder, { recursive: true });
    writeFileSync(
      join(migrationsFolder, 'meta/_journal.json'),
      JSON.stringify({
        ...journal,
        entries: journal.entries.filter(
          (entry: { idx: number }) => entry.idx < 6,
        ),
      }),
    );
  }
  await migrate(db, { migrationsFolder });
  await client.executeMultiple(`
    PRAGMA foreign_keys=ON;
    INSERT INTO users(id,name,email,email_verified,role,created_at,updated_at) VALUES('reader','Reader','reader@example.invalid',1,'user',1,1),('other','Other','other@example.invalid',1,'user',1,1),('owner','Owner','owner@example.invalid',1,'owner',1,1);
    INSERT INTO collections(id,name,owner_user_id,is_personal,created_at,updated_at) VALUES('one','One','owner',0,1,1),('two','Two','owner',0,1,1),('away','Inaccessible','owner',0,1,1);
    ${legacy ? "INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES('one','owner','owner',1),('two','owner','owner',1),('away','owner','owner',1);" : ''}
    INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES('one','reader','viewer',1),('two','reader','viewer',1);
    ${legacy ? "INSERT INTO books(id,title,created_at,updated_at) VALUES('a','Alpha',1,1),('b','Beta',1,1),('c','Gamma',1,1); INSERT INTO collection_books(collection_id,book_id,added_at) VALUES('one','a',1),('two','a',1),('one','b',1),('one','c',1);" : "INSERT INTO books(id,title,collection_id,created_at,updated_at) VALUES('a','Alpha','two',1,1),('b','Beta','one',1,1),('c','Gamma','one',1,1);"}
    INSERT INTO user_book_status(user_id,book_id,status,tbr_rank,updated_at) VALUES('reader','a','to_be_read',1,1),('reader','b','to_be_read',2,1),('reader','c','to_be_read',3,1);
  `);
  if (legacy)
    writeFileSync(
      join(migrationsFolder, 'meta/_journal.json'),
      JSON.stringify({
        ...journal,
        entries: journal.entries.filter(
          (entry: { idx: number }) => entry.idx <= 6,
        ),
      }),
    );
  const ranks = async () =>
    (
      await client.execute(
        "SELECT book_id,tbr_rank FROM user_book_status WHERE user_id='reader' AND tbr_rank IS NOT NULL ORDER BY tbr_rank",
      )
    ).rows.map((row) => [row.book_id, row.tbr_rank]);
  return {
    client,
    db,
    ranks,
    migrationsFolder,
    cleanup: () => {
      client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('losing and restoring access closes gaps and appends even without an intervening queue read', async () => {
  const { client, ranks, cleanup } = await fixture();
  try {
    await client.execute(
      "DELETE FROM collection_members WHERE collection_id='one' AND user_id='reader'",
    );
    assert.deepEqual(await ranks(), [['a', 1]]);
    await client.execute(
      "INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES ('one','reader','viewer',2)",
    );
    assert.deepEqual(await ranks(), [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    await client.execute("UPDATE books SET collection_id='away' WHERE id='b'");
    assert.deepEqual(await ranks(), [
      ['a', 1],
      ['c', 2],
    ]);
    await client.execute("UPDATE books SET collection_id='one' WHERE id='b'");
    assert.deepEqual(await ranks(), [
      ['a', 1],
      ['c', 2],
      ['b', 3],
    ]);
  } finally {
    cleanup();
  }
});

test('upgrading an existing database backfills visible ranks and restart preserves notes and order', async () => {
  const { client, db, ranks, cleanup, migrationsFolder } = await fixture({
    legacy: true,
  });
  try {
    await client.execute(
      "UPDATE user_book_status SET tbr_rank=CASE book_id WHEN 'c' THEN 1 WHEN 'b' THEN 2 ELSE 3 END",
    );
    await client.execute(
      "DELETE FROM collection_books WHERE collection_id='one' AND book_id='b'",
    );
    await migrate(db, { migrationsFolder });
    assert.deepEqual(await ranks(), [
      ['c', 1],
      ['a', 2],
    ]);
    await client.execute(
      "INSERT INTO collection_books(collection_id,book_id,added_at) VALUES ('one','b',2)",
    );
    assert.deepEqual(await ranks(), [
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ]);
    await writeRationale(db, {
      userId: readerId,
      bookId: bookB,
      text: 'Retain across restart',
    });
    await migrate(db, { migrationsFolder });
    assert.deepEqual(await ranks(), [
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ]);
    assert.equal(
      await readRationale(db, { userId: readerId, bookId: bookB }),
      'Retain across restart',
    );
  } finally {
    cleanup();
  }
});

test('the queue includes all 63 books across exclusive collections and preserves ordered authors', async () => {
  const { client, db, cleanup } = await fixture();
  try {
    await client.executeMultiple(`
      INSERT INTO authors(id,name,created_at,updated_at) VALUES ('first','First',1,1),('last','Last',1,1);
      INSERT INTO book_authors(book_id,author_id,position) VALUES ('a','last',1),('a','first',0);
    `);
    const ids = Array.from({ length: 60 }, (_, index) => `extra-${index}`);
    for (const id of ids) {
      await client.execute({
        sql: "INSERT INTO books(id,title,collection_id,created_at,updated_at) VALUES (?,?,'one',1,1)",
        args: [id, id],
      });
    }
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: ids,
      change: { status: 'to_be_read' },
      now: new Date(),
    });
    await writeRationale(db, {
      userId: readerId,
      bookId: bookA,
      text: 'Read this first',
    });
    const queue = await getTbrQueue(db, 'reader');
    assert.equal(queue.count, 63);
    assert.equal(new Set(queue.books.map((book) => book.id)).size, 63);
    assert.deepEqual(
      queue.books.map((book) => book.rank),
      Array.from({ length: 63 }, (_, i) => i + 1),
    );
    assert.deepEqual(queue.books[0]?.authors, [
      { id: 'first', name: 'First' },
      { id: 'last', name: 'Last' },
    ]);
    assert.equal(queue.books[0]?.rationale, 'Read this first');
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: [ids[59]!],
      change: { tbrRank: 1 },
      now: new Date(),
    });
    assert.equal((await getTbrQueue(db, 'reader')).books[0]?.id, ids[59]);
  } finally {
    cleanup();
  }
});

test('rationale is private, shared by both read surfaces, and independent of reading status', async () => {
  const { client, db, cleanup } = await fixture();
  try {
    assert.equal(
      await readRationale(db, { userId: readerId, bookId: bookA }),
      '',
    );
    await writeRationale(db, {
      userId: readerId,
      bookId: bookA,
      text: 'A private reason',
    });
    await client.execute(
      "INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES ('two','other','viewer',1)",
    );
    assert.equal(
      await readRationale(db, { userId: otherId, bookId: bookA }),
      '',
    );
    await writeRationale(db, {
      userId: otherId,
      bookId: bookA,
      text: 'A different reason',
    });
    assert.equal(
      await readRationale(db, { userId: readerId, bookId: bookA }),
      'A private reason',
    );
    assert.deepEqual(await getTbrQueue(db, 'other'), { books: [], count: 0 });
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: ['a'],
      change: { status: 'finished' },
      now: new Date(),
    });
    assert.equal(
      await readRationale(db, { userId: readerId, bookId: bookA }),
      'A private reason',
    );
    assert.equal((await getTbrQueue(db, 'reader')).count, 2);
    const progress = await client.execute(
      "SELECT progress_percent FROM user_book_progress_log WHERE user_id='reader' AND book_id='a'",
    );
    assert.equal(progress.rows[0]?.progress_percent, 100);
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: ['a'],
      change: { status: null },
      now: new Date(),
    });
    await writeRationale(db, {
      userId: readerId,
      bookId: bookA,
      text: 'Edited after clearing status',
    });
    assert.equal(
      await readRationale(db, { userId: readerId, bookId: bookA }),
      'Edited after clearing status',
    );
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: ['a'],
      change: { status: 'to_be_read' },
      now: new Date(),
    });
    assert.equal(
      (await getTbrQueue(db, 'reader')).books.at(-1)?.rationale,
      'Edited after clearing status',
    );
    await writeRationale(db, { userId: readerId, bookId: bookA, text: '' });
    assert.equal(
      await readRationale(db, { userId: readerId, bookId: bookA }),
      '',
    );
  } finally {
    cleanup();
  }
});

test('queue and rationale enforce visibility, including restore without an intermediate request', async () => {
  const { client, db, ranks, cleanup } = await fixture();
  try {
    await writeRationale(db, {
      userId: readerId,
      bookId: bookB,
      text: 'Remember this',
    });
    await assert.rejects(
      readRationale(db, { userId: otherId, bookId: bookB }),
      { statusCode: 404 },
    );
    await assert.rejects(
      writeRationale(db, { userId: otherId, bookId: bookB, text: 'Overwrite' }),
      {
        statusCode: 404,
      },
    );
    await client.execute("UPDATE books SET collection_id='away' WHERE id='b'");
    await assert.rejects(
      readRationale(db, { userId: readerId, bookId: bookB }),
      { statusCode: 404 },
    );
    await client.execute("UPDATE books SET collection_id='one' WHERE id='b'");
    assert.deepEqual(await ranks(), [
      ['a', 1],
      ['c', 2],
      ['b', 3],
    ]);
    assert.equal(
      (await getTbrQueue(db, 'reader')).books.at(-1)?.rationale,
      'Remember this',
    );
    await assert.rejects(
      client.execute("DELETE FROM collections WHERE id='one'"),
      /empty the collection/,
    );
    await client.execute(
      "UPDATE books SET collection_id='away' WHERE collection_id='one'",
    );
    await client.execute("DELETE FROM collections WHERE id='one'");
    assert.deepEqual(await ranks(), [['a', 1]]);
    assert.equal((await getTbrQueue(db, 'reader')).count, 1);
  } finally {
    cleanup();
  }
});

test('numeric and bulk status changes use one order and failed transactions restore saved state', async () => {
  const { client, db, ranks, cleanup } = await fixture();
  try {
    await writeRationale(db, {
      userId: readerId,
      bookId: bookA,
      text: 'Preserve this',
    });
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: ['c'],
      change: { tbrRank: 1 },
      now: new Date(),
    });
    assert.deepEqual(await ranks(), [
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ]);
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: ['c', 'b'],
      change: { status: 'reading' },
      now: new Date(),
    });
    assert.deepEqual(await ranks(), [['a', 1]]);
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: ['b', 'c'],
      change: { status: 'to_be_read' },
      now: new Date(),
    });
    assert.deepEqual(await ranks(), [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    await client.execute(
      "CREATE TRIGGER fail_rank BEFORE UPDATE OF tbr_rank ON user_book_status WHEN NEW.tbr_rank=2 BEGIN SELECT RAISE(ABORT,'injected storage failure'); END",
    );
    await assert.rejects(
      transitionBookStatuses(db, {
        userId: 'reader',
        bookIds: ['c'],
        change: { tbrRank: 1 },
        now: new Date(),
      }),
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        /injected storage failure/.test(error.cause.message),
    );
    assert.deepEqual(await ranks(), [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    assert.equal(
      await readRationale(db, { userId: readerId, bookId: bookA }),
      'Preserve this',
    );
    await assert.rejects(
      transitionBookStatuses(db, {
        userId: 'reader',
        bookIds: ['a'],
        change: { finishedAt: new Date(1), startedAt: new Date(1000) },
        now: new Date(),
      }),
      { statusCode: 400 },
    );
  } finally {
    cleanup();
  }
});

test('access normalization preserves reversed order and rolls back with a failed membership transaction', async () => {
  const { client, db, ranks, cleanup } = await fixture();
  try {
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: ['c'],
      change: { tbrRank: 1 },
      now: new Date(),
    });
    await transitionBookStatuses(db, {
      userId: 'reader',
      bookIds: ['b'],
      change: { tbrRank: 2 },
      now: new Date(),
    });
    assert.deepEqual(await ranks(), [
      ['c', 1],
      ['b', 2],
      ['a', 3],
    ]);
    await client.execute("UPDATE books SET collection_id='away' WHERE id='c'");
    assert.deepEqual(await ranks(), [
      ['b', 1],
      ['a', 2],
    ]);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.run(
          sql`DELETE FROM collection_members WHERE collection_id='one' AND user_id='reader'`,
        );
        throw new Error('rollback');
      }),
    );
    assert.deepEqual(await ranks(), [
      ['b', 1],
      ['a', 2],
    ]);
  } finally {
    cleanup();
  }
});
