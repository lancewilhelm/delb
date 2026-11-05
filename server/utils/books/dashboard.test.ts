import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDashboard, setBookFavorite } from './dashboard';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'delb-dashboard-'));
  const client = createClient({ url: `file:${join(directory, 'test.db')}` });
  for (const statement of [
    'CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, cover_image_path TEXT, updated_at INTEGER)',
    'CREATE TABLE collection_books (collection_id TEXT, book_id TEXT)',
    'CREATE TABLE collection_members (collection_id TEXT, user_id TEXT)',
    'CREATE TABLE user_book_status (user_id TEXT, book_id TEXT, status TEXT, finished_at INTEGER, updated_at INTEGER, UNIQUE(user_id, book_id))',
    'CREATE TABLE user_book_reading_position (user_id TEXT, book_id TEXT, progress REAL, updated_at INTEGER, UNIQUE(user_id, book_id))',
    'CREATE TABLE user_book_preferences (user_id TEXT, book_id TEXT, favorite INTEGER NOT NULL DEFAULT 0, progress_sync_enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, UNIQUE(user_id, book_id))',
    'CREATE TABLE book_ratings (user_id TEXT, book_id TEXT, rating INTEGER)',
    "INSERT INTO books VALUES ('1','One',NULL,900),('2','Two',NULL,800),('3','Three',NULL,9999),('4','Four',NULL,1),('5','Undated',NULL,500),('6','Hidden',NULL,1000)",
    "INSERT INTO collection_books VALUES ('x','1'),('x','2'),('x','3'),('x','4'),('x','5'),('y','1'),('y','4'),('z','6')",
    "INSERT INTO collection_members VALUES ('x','u'),('y','u'),('y','other'),('z','owner')",
    "INSERT INTO user_book_status VALUES ('u','1','reading',NULL,80),('u','2','reading',NULL,90),('u','3','finished',100,9999),('u','4','finished',200,1),('u','5','finished',NULL,500),('other','1','finished',300,300),('u','6','finished',900,900)",
    "INSERT INTO user_book_reading_position VALUES ('u','1',10,20),('u','2',35,10),('other','1',95,1000)",
    "INSERT INTO user_book_preferences VALUES ('u','1',1,0,0),('u','2',0,1,0),('u','3',1,0,0),('other','4',1,0,0),('u','6',1,0,0)",
    "INSERT INTO book_ratings VALUES ('u','2',7)",
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
    result.shelf.books.map((book) => [
      book.id,
      book.progress,
      book.userFavorite,
    ]),
    [
      ['1', 10, true],
      ['2', 35, false],
    ],
  );
  assert.equal(result.shelf.nextOffset, null);
});

test('Recently read orders by the current user finish date and excludes undated and inaccessible books', async (t) => {
  const { db, cleanup } = await fixture();
  t.after(cleanup);
  const result = await getDashboard(db, { userId: 'u', shelf: 'recent' });
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
    shelf: 'recent',
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
        shelf: 'recent',
        collectionId: 'z',
      })
    ).shelf.books,
    [],
  );
});

test('favorites are independent of status, scoped to visible books, and private to each reader', async (t) => {
  const { db, cleanup } = await fixture();
  t.after(cleanup);
  const personal = await getDashboard(db, { userId: 'u', shelf: 'favorites' });
  assert.deepEqual(
    personal.shelf.books.map((book) => book.id),
    ['1', '3'],
  );
  const other = await getDashboard(db, { userId: 'other', shelf: 'favorites' });
  assert.deepEqual(
    other.shelf.books.map((book) => book.id),
    ['4'],
  );
  assert.equal(other.counts.total, 2);
  const scoped = await getDashboard(db, {
    userId: 'u',
    shelf: 'favorites',
    collectionId: 'y',
  });
  assert.deepEqual(
    scoped.shelf.books.map((book) => book.id),
    ['1'],
  );
  assert.deepEqual(
    personal.counts,
    (await getDashboard(db, { userId: 'u', shelf: 'recent' })).counts,
  );
});

test('setting favorites is retry-safe and preserves sync settings, status, ratings, and other users', async (t) => {
  const { client, db, cleanup } = await fixture();
  t.after(cleanup);
  for (const favorite of [true, true, false, false, true]) {
    assert.deepEqual(
      await setBookFavorite(db, { userId: 'u', bookId: '2', favorite }),
      { userFavorite: favorite },
    );
  }
  const prefs = await client.execute(
    "SELECT favorite, progress_sync_enabled FROM user_book_preferences WHERE user_id='u' AND book_id='2'",
  );
  assert.deepEqual(
    prefs.rows.map((row) => [row.favorite, row.progress_sync_enabled]),
    [[1, 1]],
  );
  assert.equal(
    (
      await client.execute(
        "SELECT status FROM user_book_status WHERE user_id='u' AND book_id='2'",
      )
    ).rows[0]?.status,
    'reading',
  );
  assert.equal(
    (
      await client.execute(
        "SELECT rating FROM book_ratings WHERE user_id='u' AND book_id='2'",
      )
    ).rows[0]?.rating,
    7,
  );
  assert.equal(
    await setBookFavorite(db, { userId: 'u', bookId: '6', favorite: true }),
    null,
  );
  assert.equal(
    await setBookFavorite(db, {
      userId: 'u',
      bookId: 'missing',
      favorite: true,
    }),
    null,
  );
  assert.deepEqual(
    (
      await getDashboard(db, { userId: 'other', shelf: 'favorites' })
    ).shelf.books.map((book) => book.id),
    ['4'],
  );
  assert.deepEqual(
    await setBookFavorite(db, { userId: 'u', bookId: '4', favorite: true }),
    { userFavorite: true },
  );
});

test('all shelf pages stay bounded, stable at equal dates, and reachable past the first twelve', async (t) => {
  const { client, db, cleanup } = await fixture();
  t.after(cleanup);
  for (let index = 0; index < 15; index++) {
    const id = `page-${String(index).padStart(2, '0')}`;
    await client.execute({
      sql: 'INSERT INTO books VALUES (?, ?, NULL, 100)',
      args: [id, id],
    });
    await client.execute({
      sql: "INSERT INTO collection_books VALUES ('x', ?)",
      args: [id],
    });
    await client.execute({
      sql: "INSERT INTO user_book_status VALUES ('u', ?, 'finished', 1000, 0)",
      args: [id],
    });
    await setBookFavorite(db, { userId: 'u', bookId: id, favorite: true });
  }
  for (const shelf of ['recent', 'favorites'] satisfies (
    'recent' | 'favorites'
  )[]) {
    const first = await getDashboard(db, { userId: 'u', shelf });
    assert.equal(first.shelf.books.length, 12);
    assert.equal(first.shelf.nextOffset, 12);
    const next = await getDashboard(db, {
      userId: 'u',
      shelf,
      offset: first.shelf.nextOffset ?? 0,
    });
    assert.equal(next.shelf.nextOffset, null);
    const ids = [...first.shelf.books, ...next.shelf.books].map(
      (book) => book.id,
    );
    assert.equal(ids.length, 17);
    assert.equal(new Set(ids).size, 17);
    assert.deepEqual(next.counts, first.counts);
  }
});

test('the additive favorite migration preserves existing progress sync preferences', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute(
      'CREATE TABLE user_book_preferences (user_id TEXT, book_id TEXT, progress_sync_enabled INTEGER, updated_at INTEGER)',
    );
    await client.execute(
      "INSERT INTO user_book_preferences VALUES ('u','book',1,123)",
    );
    await client.execute(
      readFileSync('.drizzle/migrations/0006_short_lightspeed.sql', 'utf8'),
    );
    const result = await client.execute(
      'SELECT favorite, progress_sync_enabled, updated_at FROM user_book_preferences',
    );
    assert.deepEqual(
      result.rows.map((row) => [
        row.favorite,
        row.progress_sync_enabled,
        row.updated_at,
      ]),
      [[0, 1, 123]],
    );
  } finally {
    client.close();
  }
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
      const result = await getDashboard(db, { userId: 'u', shelf: 'recent' });
      assert.equal(
        result.shelf.books.find((book) => book.id === '4')?.finishedDate,
        '2026-11-02',
      );
    } finally {
      cleanup();
    }
  }
});
