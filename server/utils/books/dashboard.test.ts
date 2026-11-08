import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDashboard } from './dashboard';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'delb-dashboard-'));
  const client = createClient({ url: `file:${join(directory, 'test.db')}` });
  for (const statement of [
    'CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, cover_image_path TEXT, updated_at INTEGER, has_physical_copy INTEGER NOT NULL DEFAULT 0, has_audiobook_copy INTEGER NOT NULL DEFAULT 0)',
    'CREATE TABLE collection_books (collection_id TEXT, book_id TEXT)',
    'CREATE TABLE collection_members (collection_id TEXT, user_id TEXT)',
    'CREATE TABLE user_book_status (user_id TEXT, book_id TEXT, status TEXT, finished_at INTEGER, updated_at INTEGER, tbr_rank INTEGER, UNIQUE(user_id, book_id))',
    'CREATE TABLE user_book_reading_position (user_id TEXT, book_id TEXT, progress REAL, updated_at INTEGER, UNIQUE(user_id, book_id))',
    "INSERT INTO books (id, title, cover_image_path, updated_at) VALUES ('1','One',NULL,900),('2','Two',NULL,800),('3','Three',NULL,9999),('4','Four',NULL,1),('5','Undated',NULL,500),('6','Hidden',NULL,1000)",
    "INSERT INTO collection_books VALUES ('x','1'),('x','2'),('x','3'),('x','4'),('x','5'),('y','1'),('y','4'),('z','6')",
    "INSERT INTO collection_members VALUES ('x','u'),('y','u'),('y','other'),('z','owner')",
    "INSERT INTO user_book_status VALUES ('u','1','reading',NULL,80,NULL),('u','2','reading',NULL,90,NULL),('u','3','finished',100,9999,NULL),('u','4','finished',200,1,NULL),('u','5','finished',NULL,500,NULL),('other','1','finished',300,300,NULL),('u','6','finished',900,900,NULL)",
    "INSERT INTO user_book_reading_position VALUES ('u','1',10,20),('u','2',35,10),('other','1',95,1000)",
  ])
    await client.execute(statement);
  return {
    client,
    db: drizzle(client),
    cleanup: () => {
      client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('shelves count each visible book once and preserve personal reading order and progress', async (t) => {
  const { db, cleanup } = await fixture();
  t.after(cleanup);
  const result = await getDashboard(db, { userId: 'u', shelf: 'reading' });
  assert.deepEqual(result.counts, {
    total: 5,
    reading: 2,
    finished: 3,
    to_be_read: 0,
    dnf: 0,
    none: 0,
  });
  assert.deepEqual(
    result.shelf.books.map((book) => [book.id, book.progress]),
    [
      ['1', 10],
      ['2', 35],
    ],
  );
  assert.equal(result.shelf.nextOffset, null);
});

test('Recently read orders by the current user finish date and excludes undated and inaccessible books', async (t) => {
  const { db, cleanup } = await fixture();
  t.after(cleanup);
  const result = await getDashboard(db, { userId: 'u', shelf: 'finished' });
  assert.deepEqual(
    result.shelf.books.map((book) => book.id),
    ['4', '3'],
  );
  assert.match(
    result.shelf.books[0]?.finishedDate ?? '',
    /^\d{4}-\d{2}-\d{2}$/,
  );
  const scoped = await getDashboard(db, {
    userId: 'u',
    shelf: 'finished',
    collectionId: 'y',
  });
  assert.equal(scoped.counts.total, 2);
  assert.deepEqual(
    scoped.shelf.books.map((book) => book.id),
    ['4'],
  );
  assert.deepEqual(
    (
      await getDashboard(db, {
        userId: 'u',
        shelf: 'finished',
        collectionId: 'z',
      })
    ).shelf.books,
    [],
  );
});

test('shared books keep reading status and counts private to each reader', async (t) => {
  const { db, cleanup } = await fixture();
  t.after(cleanup);
  const other = await getDashboard(db, { userId: 'other', shelf: 'finished' });
  assert.deepEqual(
    other.shelf.books.map((book) => book.id),
    ['1'],
  );
  assert.equal(other.counts.total, 2);
  assert.equal(other.counts.finished, 1);
  assert.equal(other.counts.none, 1);
  assert.deepEqual(
    (await getDashboard(db, { userId: 'other', shelf: 'reading' })).shelf.books,
    [],
  );
});

test('the global personal TBR count preserves scoped shelf contents and other counts', async (t) => {
  const { client, db, cleanup } = await fixture();
  t.after(cleanup);
  await client.execute(
    "UPDATE user_book_status SET status='to_be_read' WHERE user_id='u' AND book_id='2'",
  );
  const result = await getDashboard(db, {
    userId: 'u',
    shelf: 'reading',
    collectionId: 'y',
  });
  assert.equal(result.counts.total, 2);
  assert.equal(result.counts.to_be_read, 1);
  assert.equal(result.counts.reading, 1);
  assert.equal(result.counts.finished, 1);
  assert.deepEqual(
    result.shelf.books.map((book) => book.id),
    ['1'],
  );
});

test('TBR shelf follows queue rank within the selected collection and keeps unranked books', async (t) => {
  const { client, db, cleanup } = await fixture();
  t.after(cleanup);
  await client.execute(
    "UPDATE user_book_status SET status='to_be_read', tbr_rank=2 WHERE user_id='u' AND book_id='1'",
  );
  await client.execute(
    "UPDATE user_book_status SET status='to_be_read', tbr_rank=1 WHERE user_id='u' AND book_id='2'",
  );
  await client.execute(
    "UPDATE user_book_status SET status='to_be_read', tbr_rank=NULL WHERE user_id='u' AND book_id='4'",
  );
  await client.execute(
    "UPDATE user_book_status SET status='to_be_read', tbr_rank=0 WHERE user_id='u' AND book_id='6'",
  );
  const all = await getDashboard(db, { userId: 'u', shelf: 'tbr' });
  assert.equal(all.shelf.kind, 'tbr');
  assert.deepEqual(
    all.shelf.books.map((book) => book.id),
    ['2', '1', '4'],
  );
  const scoped = await getDashboard(db, {
    userId: 'u',
    shelf: 'tbr',
    collectionId: 'y',
  });
  assert.deepEqual(
    scoped.shelf.books.map((book) => book.id),
    ['1', '4'],
  );
  assert.equal(scoped.counts.to_be_read, 3);
  const other = await getDashboard(db, { userId: 'other', shelf: 'tbr' });
  assert.deepEqual(other.shelf.books, []);
});

test('Recently read pages stay bounded, stable at equal dates, and reachable past the first twelve', async (t) => {
  const { client, db, cleanup } = await fixture();
  t.after(cleanup);
  for (let index = 0; index < 15; index++) {
    const id = `page-${String(index).padStart(2, '0')}`;
    await client.execute({
      sql: 'INSERT INTO books (id, title, cover_image_path, updated_at) VALUES (?, ?, NULL, 100)',
      args: [id, id],
    });
    await client.execute({
      sql: "INSERT INTO collection_books VALUES ('x', ?)",
      args: [id],
    });
    await client.execute({
      sql: "INSERT INTO user_book_status VALUES ('u', ?, 'finished', 1000, 0, NULL)",
      args: [id],
    });
  }
  const first = await getDashboard(db, { userId: 'u', shelf: 'finished' });
  assert.equal(first.shelf.books.length, 12);
  assert.equal(first.shelf.nextOffset, 12);
  const next = await getDashboard(db, {
    userId: 'u',
    shelf: 'finished',
    offset: first.shelf.nextOffset ?? 0,
  });
  assert.equal(next.shelf.nextOffset, null);
  const ids = [...first.shelf.books, ...next.shelf.books].map(
    (book) => book.id,
  );
  assert.equal(ids.length, 17);
  assert.equal(new Set(ids).size, 17);
  assert.deepEqual(next.counts, first.counts);
});

test('finish dates retain the server calendar date when serialized', async (t) => {
  const previousTimezone = process.env.TZ;
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });
  for (const timezone of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
    process.env.TZ = timezone;
    const { client, db, cleanup } = await fixture();
    try {
      await client.execute({
        sql: "UPDATE user_book_status SET finished_at=? WHERE user_id='u' AND book_id='4'",
        args: [new Date(2026, 10, 2).getTime() / 1000],
      });
      const result = await getDashboard(db, { userId: 'u', shelf: 'finished' });
      assert.equal(
        result.shelf.books.find((book) => book.id === '4')?.finishedDate,
        '2026-11-02',
      );
    } finally {
      cleanup();
    }
  }
});
