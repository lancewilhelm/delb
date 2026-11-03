import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { enrichBookViewPage } from './view-metadata';

test('view metadata enriches only the supplied page and isolates personal values', async () => {
  const client = createClient({ url: ':memory:' });
  const db = drizzle(client);
  try {
    for (const sql of [
      'CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT)',
      'CREATE TABLE book_tags (book_id TEXT, tag_id TEXT)',
      'CREATE TABLE book_identifiers (book_id TEXT, type TEXT, value TEXT)',
      'CREATE TABLE book_files (id TEXT, book_id TEXT, format TEXT)',
      'CREATE TABLE book_ratings (book_id TEXT, user_id TEXT, rating INTEGER)',
      'CREATE TABLE user_book_status (book_id TEXT, user_id TEXT, status TEXT)',
      "INSERT INTO tags VALUES ('t2', 'Zebra'), ('t1', 'Alpha')",
      "INSERT INTO book_tags VALUES ('a', 't2'), ('a', 't1'), ('hidden', 't2')",
      "INSERT INTO book_identifiers VALUES ('a', 'isbn', '123'), ('hidden', 'isbn', 'secret')",
      "INSERT INTO book_files VALUES ('f1', 'a', 'epub'), ('f2', 'a', 'epub'), ('f3', 'a', 'pdf')",
      "INSERT INTO book_ratings VALUES ('a', 'alice', 7), ('a', 'bob', 2), ('hidden', 'alice', 10)",
      "INSERT INTO user_book_status VALUES ('a', 'alice', 'reading'), ('a', 'bob', 'finished')",
    ])
      await client.execute(sql);
    const page = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ];
    const result = await enrichBookViewPage(db, page, 'alice');
    assert.deepEqual(
      result.map((b) => b.id),
      ['a', 'b'],
    );
    assert.deepEqual(result[0], {
      id: 'a',
      title: 'A',
      tags: [
        { id: 't1', name: 'Alpha' },
        { id: 't2', name: 'Zebra' },
      ],
      identifiers: [{ type: 'isbn', value: '123' }],
      formats: ['epub', 'pdf'],
      rating: 7,
      status: 'reading',
    });
    assert.deepEqual(result[1], {
      id: 'b',
      title: 'B',
      tags: [],
      identifiers: [],
      formats: [],
      rating: null,
      status: null,
    });
    assert.equal((await enrichBookViewPage(db, page, 'bob'))[0]?.rating, 2);
    assert.deepEqual(await enrichBookViewPage(db, [], 'alice'), []);
  } finally {
    client.close();
  }
});
