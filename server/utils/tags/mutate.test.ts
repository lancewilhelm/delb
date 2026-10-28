import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { mutateTag } from './mutate';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'delb-tags-'));
  const client = createClient({ url: `file:${join(dir, 'test.db')}` });
  for (const sql of [
    'CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    'CREATE TABLE books (id TEXT PRIMARY KEY)',
    'CREATE TABLE collection_books (collection_id TEXT NOT NULL, book_id TEXT NOT NULL)',
    'CREATE TABLE collection_members (collection_id TEXT NOT NULL, user_id TEXT NOT NULL)',
    'CREATE TABLE book_tags (book_id TEXT NOT NULL REFERENCES books(id), tag_id TEXT NOT NULL REFERENCES tags(id), UNIQUE(book_id, tag_id))',
    "INSERT INTO tags VALUES ('source','Source'),('target','Target'),('hidden','Hidden')",
    "INSERT INTO books VALUES ('a'),('b'),('c')",
    "INSERT INTO collection_books VALUES ('visible','a'),('visible','b'),('hidden','c')",
    "INSERT INTO collection_members VALUES ('visible','user')",
    "INSERT INTO book_tags VALUES ('a','source'),('b','source'),('c','source'),('a','target'),('c','hidden')",
  ])
    await client.execute(sql);
  return {
    client,
    db: drizzle(client),
    cleanup: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('merge preserves all books and deduplicates links across collections', async () => {
  const { client, db, cleanup } = await fixture();
  try {
    await mutateTag(db, 'user', {
      kind: 'merge',
      sourceId: 'source',
      targetId: 'target',
    });
    const links = await client.execute(
      'SELECT book_id, tag_id FROM book_tags ORDER BY tag_id, book_id',
    );
    assert.deepEqual(
      links.rows.map((r) => [r.book_id, r.tag_id]),
      [
        ['c', 'hidden'],
        ['a', 'target'],
        ['b', 'target'],
        ['c', 'target'],
      ],
    );
    assert.equal(
      (await client.execute('SELECT count(*) AS n FROM books')).rows[0]?.n,
      3,
    );
    await assert.rejects(
      mutateTag(db, 'user', {
        kind: 'merge',
        sourceId: 'source',
        targetId: 'target',
      }),
      /Tag not found/,
    );
  } finally {
    cleanup();
  }
});

test('visibility, self merge and transaction rollback protect tags', async () => {
  const { client, db, cleanup } = await fixture();
  try {
    await assert.rejects(
      mutateTag(db, 'user', {
        kind: 'merge',
        sourceId: 'source',
        targetId: 'hidden',
      }),
      /Tag not found/,
    );
    await assert.rejects(
      mutateTag(db, 'user', { kind: 'delete', sourceId: 'hidden' }),
      /Tag not found/,
    );
    await assert.rejects(
      mutateTag(db, 'user', {
        kind: 'merge',
        sourceId: 'source',
        targetId: 'source',
      }),
      /different/,
    );
    await client.execute(
      "CREATE TRIGGER stop_delete BEFORE DELETE ON tags BEGIN SELECT RAISE(ABORT, 'stop'); END",
    );
    await assert.rejects(
      mutateTag(db, 'user', {
        kind: 'merge',
        sourceId: 'source',
        targetId: 'target',
      }),
    );
    assert.equal(
      (
        await client.execute(
          "SELECT count(*) AS n FROM book_tags WHERE tag_id='source'",
        )
      ).rows[0]?.n,
      3,
    );
    assert.equal(
      (
        await client.execute(
          "SELECT count(*) AS n FROM book_tags WHERE tag_id='target'",
        )
      ).rows[0]?.n,
      1,
    );
  } finally {
    cleanup();
  }
});

test('delete removes links without deleting books and repeated delete is safe', async () => {
  const { client, db, cleanup } = await fixture();
  try {
    await mutateTag(db, 'user', { kind: 'delete', sourceId: 'source' });
    assert.equal(
      (
        await client.execute(
          "SELECT count(*) AS n FROM book_tags WHERE tag_id='source'",
        )
      ).rows[0]?.n,
      0,
    );
    assert.equal(
      (await client.execute('SELECT count(*) AS n FROM books')).rows[0]?.n,
      3,
    );
    await assert.rejects(
      mutateTag(db, 'user', { kind: 'delete', sourceId: 'source' }),
      /Tag not found/,
    );
  } finally {
    cleanup();
  }
});

test('concurrent merges cannot duplicate links or remove the destination', async () => {
  const { client, db, cleanup } = await fixture();
  try {
    const commands = await Promise.allSettled([
      mutateTag(db, 'user', {
        kind: 'merge',
        sourceId: 'source',
        targetId: 'target',
      }),
      mutateTag(db, 'user', {
        kind: 'merge',
        sourceId: 'source',
        targetId: 'target',
      }),
    ]);
    assert.equal(
      commands.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      (await client.execute("SELECT count(*) AS n FROM tags WHERE id='target'"))
        .rows[0]?.n,
      1,
    );
    assert.equal(
      (
        await client.execute(
          "SELECT count(*) AS n FROM book_tags WHERE tag_id='target'",
        )
      ).rows[0]?.n,
      3,
    );
    assert.equal(
      (
        await client.execute(
          "SELECT count(*) AS n FROM book_tags WHERE tag_id='source'",
        )
      ).rows[0]?.n,
      0,
    );
  } finally {
    cleanup();
  }
});
