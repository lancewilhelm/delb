import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { books } from '../../../app/utils/db/schema';
import {
  bookSort,
  decodeCursor,
  nextBookCursor,
  type SortKey,
  type SortDir,
} from './book-sort';

const expected = {
  dateAdded: { asc: [1, 2, 3, 4, 5, 6, 7], desc: [7, 6, 5, 4, 3, 2, 1] },
  alphabetical: { asc: [2, 3, 5, 7, 1, 6, 4], desc: [4, 6, 1, 7, 5, 3, 2] },
  publishedDate: { asc: [2, 6, 3, 7, 1, 4, 5], desc: [5, 4, 1, 7, 3, 6, 2] },
  pages: { asc: [3, 7, 1, 4, 5, 2, 6], desc: [5, 4, 1, 7, 3, 6, 2] },
} satisfies Record<SortKey, Record<SortDir, number[]>>;

for (const sort of [
  'dateAdded',
  'alphabetical',
  'publishedDate',
  'pages',
] satisfies SortKey[]) {
  for (const direction of ['asc', 'desc'] satisfies SortDir[]) {
    test(`${sort} ${direction} traverses ties and missing values across SQLite pages`, async () => {
      const client = createClient({ url: ':memory:' });
      const db = drizzle(client);
      try {
        await client.executeMultiple(`CREATE TABLE books (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, sort_title TEXT NOT NULL,
          calibre_book_id INTEGER, description TEXT, published TEXT, published_at INTEGER,
          language TEXT, pages INTEGER, cover_image_path TEXT, publisher_id TEXT,
          series_id TEXT, series_index REAL, created_by_user_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )`);
        const names = [
          'delta',
          'alpha',
          'alpha',
          'zeta',
          'beta',
          'gamma',
          'beta',
        ];
        const pages = [100, null, 0, 100, 200, -1, 50];
        const dates = [20, null, 10, 20, 30, null, 10];
        for (let i = 0; i < names.length; i++) {
          const published = dates[i];
          await db.insert(books).values({
            id: String(i + 1),
            title: `Book ${i + 1}`,
            sortTitle: names[i],
            pages: pages[i],
            publishedAt:
              typeof published === 'number' ? new Date(published * 1000) : null,
            createdAt: new Date(1700000000000 + Math.floor(i / 2) * 100000),
            updatedAt: new Date(1700000000000),
          });
        }
        let cursor: string | null = null;
        const ids: number[] = [];
        do {
          const ordering = bookSort(sort, direction, decodeCursor(cursor));
          const rows = await db
            .select()
            .from(books)
            .where(ordering.where)
            .orderBy(...ordering.orderBy)
            .limit(3);
          const page = rows.slice(0, 2);
          ids.push(...page.map((row) => Number(row.id)));
          cursor = nextBookCursor(sort, rows.length > 2, page.at(-1));
          assert.ok(
            ids.length <= 7,
            'pagination terminates without duplicate results',
          );
        } while (cursor);
        assert.deepEqual(ids, expected[sort][direction]);
      } finally {
        client.close();
      }
    });
  }
}

test('untrusted cursor values reject malformed shapes without throwing', () => {
  for (const value of [
    null,
    [],
    {},
    17,
    { id: 1, v: 'x' },
    { id: 'x', v: [] },
    { id: ' ', v: 'x' },
  ]) {
    assert.equal(
      decodeCursor(Buffer.from(JSON.stringify(value)).toString('base64url')),
      null,
    );
  }
  for (const raw of ['', 'not a cursor', 'eyJ2Ijo='])
    assert.equal(decodeCursor(raw), null);
});
