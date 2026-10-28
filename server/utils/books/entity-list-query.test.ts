import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { entityListQuery, type EntityKind } from './entity-list-query';

test('pages visible entity counts and bounded previews with stable order', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    for (const statement of [
      'CREATE TABLE authors (id TEXT, name TEXT)',
      'CREATE TABLE publishers (id TEXT, name TEXT)',
      'CREATE TABLE series (id TEXT, name TEXT)',
      'CREATE TABLE tags (id TEXT, name TEXT)',
      'CREATE TABLE books (id TEXT, title TEXT, cover_image_path TEXT, updated_at INTEGER, series_index REAL, publisher_id TEXT, series_id TEXT)',
      'CREATE TABLE book_authors (book_id TEXT, author_id TEXT)',
      'CREATE TABLE book_tags (book_id TEXT, tag_id TEXT)',
      'CREATE TABLE collection_books (book_id TEXT, collection_id TEXT)',
      'CREATE TABLE collection_members (collection_id TEXT, user_id TEXT)',
      ...['authors', 'publishers', 'series', 'tags'].map(
        (table) =>
          `INSERT INTO ${table} VALUES ('a', 'Alpha'), ('b', 'Beta'), ('c', 'Secret')`,
      ),
      "INSERT INTO books VALUES ('1', 'One', 'cover', 100, 2, 'a', 'a'), ('2', 'Two', 'cover', 100, 1, 'a', 'a'), ('3', 'Three', NULL, 100, NULL, 'b', 'b'), ('4', 'Hidden', 'cover', 100, 1, 'c', 'c')",
      "INSERT INTO book_authors VALUES ('1', 'a'), ('2', 'a'), ('3', 'b'), ('4', 'c')",
      "INSERT INTO book_tags VALUES ('1', 'a'), ('2', 'a'), ('3', 'b'), ('4', 'c')",
      "INSERT INTO collection_books VALUES ('1', 'x'), ('1', 'y'), ('2', 'x'), ('3', 'y'), ('4', 'z')",
      "INSERT INTO collection_members VALUES ('x', 'u'), ('y', 'u'), ('z', 'other')",
    ])
      await client.execute(statement);
    const db = drizzle(client);
    for (const kind of [
      'authors',
      'publishers',
      'series',
      'tags',
    ] satisfies EntityKind[]) {
      const run = (
        overrides: Partial<Parameters<typeof entityListQuery>[0]> = {},
      ) =>
        db.all<{ id: string; bookCount: number; bookId: string | null }>(
          entityListQuery({
            kind,
            userId: 'u',
            search: '',
            limit: 1,
            offset: 0,
            previewLimit: 1,
            ...overrides,
          }),
        );
      const page = await run();
      assert.deepEqual(
        page.map((r) => [r.id, r.bookCount, r.bookId]),
        [
          ['a', 2, kind === 'series' ? '2' : '1'],
          ['b', 1, null],
        ],
      );
      assert.deepEqual(
        (await run({ offset: 1 })).map((r) => r.id),
        ['b'],
      );
      assert.deepEqual(
        (await run({ search: 'beta' })).map((r) => r.id),
        ['b'],
      );
      assert.deepEqual(await run({ search: 'secret' }), []);
      assert.deepEqual(
        (await run({ collectionId: 'y', limit: 10 })).map((r) => [
          r.id,
          r.bookCount,
        ]),
        [
          ['a', 1],
          ['b', 1],
        ],
      );
      assert.equal(
        (await run({ previewLimit: -1, search: 'alpha' })).length,
        2,
      );
      assert.equal(
        (await run({ previewLimit: 0, search: 'alpha' }))[0]?.bookId,
        null,
      );
    }
  } finally {
    client.close();
  }
});
