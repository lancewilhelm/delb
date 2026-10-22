import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { and, eq, inArray } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { pageSort } from './page-sort';

const books = sqliteTable('books', {
  id: text('id').notNull(),
  pages: integer('pages'),
  status: text('status'),
});
const links = sqliteTable('links', {
  bookId: text('book_id'),
  collectionId: text('collection_id'),
});

for (const direction of ['asc', 'desc'] as const) {
  test(`numeric pages ${direction}: stable cursors, unknowns last, filters and duplicate memberships`, async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client);
    try {
      await client.execute(
        'CREATE TABLE books (id TEXT, pages INTEGER, status TEXT)',
      );
      await client.execute(
        'CREATE TABLE links (book_id TEXT, collection_id TEXT)',
      );
      const fixtures = [
        ['zero', 0],
        ['two', 2],
        ['ten-a', 10],
        ['ten-b', 10],
        ['hundred', 100],
        ['unknown-a', null],
        ['unknown-b', null],
        ['negative', -1],
        ['fraction', 1.5],
        ['text', 'invalid'],
      ] as const;
      for (const [id, pages] of fixtures) {
        await client.execute({
          sql: 'INSERT INTO books VALUES (?, ?, ?)',
          args: [id, pages, 'reading'],
        });
        // Multiple visible collection links must not duplicate a book.
        for (const collection of ['one', 'two']) {
          await client.execute({
            sql: 'INSERT INTO links VALUES (?, ?)',
            args: [id, collection],
          });
        }
      }
      await client.execute(
        "INSERT INTO books VALUES ('filtered', 3, 'finished'), ('private', 4, 'reading')",
      );
      await client.execute(
        "INSERT INTO links VALUES ('filtered', 'one'), ('private', 'private')",
      );
      const before = (await client.execute('SELECT * FROM books ORDER BY id'))
        .rows;
      const expected =
        direction === 'asc'
          ? [
              'zero',
              'two',
              'ten-a',
              'ten-b',
              'hundred',
              'fraction',
              'negative',
              'text',
              'unknown-a',
              'unknown-b',
            ]
          : [
              'hundred',
              'ten-b',
              'ten-a',
              'two',
              'zero',
              'unknown-b',
              'unknown-a',
              'text',
              'negative',
              'fraction',
            ];
      for (const size of [1, 2, 3, 48]) {
        const ids: string[] = [];
        let cursor: { v: string; id: string } | null = null;
        for (let i = 0; i < 20; i++) {
          const sort = pageSort(books.pages, books.id, direction, cursor);
          const rows = await db
            .select({ id: books.id, pages: books.pages })
            .from(books)
            .innerJoin(links, eq(links.bookId, books.id))
            .where(
              and(
                inArray(links.collectionId, ['one', 'two']),
                eq(books.status, 'reading'),
                sort.where,
              ),
            )
            .groupBy(books.id)
            .orderBy(...sort.orderBy)
            .limit(size + 1);
          const page = rows.slice(0, size);
          ids.push(...page.map((row) => row.id));
          if (rows.length <= size) break;
          const last = page[page.length - 1]!;
          // Exercise the same JSON/base64 string round trip as the API.
          cursor = JSON.parse(
            Buffer.from(
              Buffer.from(
                JSON.stringify({
                  v: sort.cursorValue(last.pages),
                  id: last.id,
                }),
              ).toString('base64url'),
              'base64url',
            ).toString(),
          );
        }
        assert.deepEqual(ids, expected, `page size ${size}`);
      }
      assert.deepEqual(
        (await client.execute('SELECT * FROM books ORDER BY id')).rows,
        before,
      );
    } finally {
      client.close();
    }
  });
}
