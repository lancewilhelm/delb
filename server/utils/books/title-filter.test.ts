import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { and, eq, gt } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { titleFilter } from './title-filter';

const books = sqliteTable('books', {
  id: text('id').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  collection: text('collection').notNull(),
});

test('title filtering composes with scope and status before pagination', async () => {
  const client = createClient({ url: ':memory:' });
  try {
    await client.execute(
      'CREATE TABLE books (id TEXT, title TEXT, status TEXT, collection TEXT)',
    );
    await client.execute(`INSERT INTO books VALUES
      ('1', 'The Hobbit', 'reading', 'mine'),
      ('2', 'A Hobbit Tale', 'finished', 'mine'),
      ('3', 'Another HOBBIT Story', 'reading', 'mine'),
      ('4', 'Hobbit Secret', 'reading', 'private'),
      ('5', 'Émilie[1]*?', 'reading', 'mine'),
      ('6', 'Émilie11abc', 'reading', 'mine')`);
    const db = drizzle(client);
    const query = (title: string, after = '') =>
      db
        .select({ id: books.id })
        .from(books)
        .where(
          and(
            eq(books.collection, 'mine'),
            eq(books.status, 'reading'),
            gt(books.id, after),
            titleFilter(books.title, title),
          ),
        )
        .orderBy(books.id)
        .limit(1);
    assert.deepEqual(await query('hobbit'), [{ id: '1' }]);
    assert.deepEqual(await query('hobbit', '1'), [{ id: '3' }]);
    assert.deepEqual(await query('hobbit', '3'), []);
    assert.deepEqual(await query('émilie[1]*?'), [{ id: '5' }]);
    assert.deepEqual(await query('émilie[2]*?'), []);
    assert.deepEqual(await query(''), [{ id: '1' }]);
  } finally {
    client.close();
  }
});
