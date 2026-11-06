import { collectionHealth } from './health';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertBookEditor,
  changeDefaultCollection,
  enrollNewUser,
  moveCollectionBooks,
  resolveBookTarget,
} from './model';

async function collectionFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'delb-collections-'));
  const client = createClient({ url: `file:${join(directory, 'test.db')}` });
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL('../../../.drizzle/migrations', import.meta.url),
    ),
  });
  await client.execute(
    "INSERT INTO users (id,name,email,email_verified,created_at,updated_at,role) VALUES ('owner','Owner','owner@example.invalid',1,0,0,'owner'),('editor','Editor','editor@example.invalid',1,0,0,'user'),('viewer','Viewer','viewer@example.invalid',1,0,0,'user')",
  );
  return {
    client,
    db,
    cleanup: () => {
      client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('stored books cannot be created without a collection', async (t) => {
  const { client, cleanup } = await collectionFixture();
  t.after(cleanup);
  await assert.rejects(
    client.execute(
      "INSERT INTO books (id,title,created_at,updated_at) VALUES ('orphan','Orphan',0,0)",
    ),
  );
});

test('new accounts join one renameable shared default and switching affects future enrollment only', async (t) => {
  const { client, db, cleanup } = await collectionFixture();
  t.after(cleanup);
  await enrollNewUser(db, 'owner');
  await enrollNewUser(db, 'editor');
  const oldId = await resolveBookTarget(db, 'editor');
  await client.execute({
    sql: 'UPDATE collections SET name=? WHERE id=?',
    args: ['Family', oldId],
  });
  assert.equal(await resolveBookTarget(db, 'editor'), oldId);
  await client.execute(
    "INSERT INTO collections(id,name,owner_user_id,is_personal,created_at,updated_at) VALUES('new','New','owner',0,0,0)",
  );
  await changeDefaultCollection(db, 'owner', 'new');
  await enrollNewUser(db, 'viewer');
  assert.deepEqual(
    (
      await client.execute(
        "SELECT collection_id,role FROM collection_members WHERE user_id='editor'",
      )
    ).rows.map((row) => [row.collection_id, row.role]),
    [[oldId, 'editor']],
  );
  assert.equal(await resolveBookTarget(db, 'viewer'), 'new');
  await assert.rejects(resolveBookTarget(db, 'editor'), /Owner or editor/);
});

test('users can have no collections and default designation grants no upload access', async (t) => {
  const { client, db, cleanup } = await collectionFixture();
  t.after(cleanup);
  await enrollNewUser(db, 'owner');
  await assert.rejects(resolveBookTarget(db, 'editor'), /Owner or editor/);
  await assert.rejects(
    resolveBookTarget(db, 'owner', ['a', 'b']),
    /exactly one/,
  );
  await assert.rejects(resolveBookTarget(db, 'owner', [42]), /exactly one/);
  assert.equal(
    (
      await client.execute(
        "SELECT * FROM collection_members WHERE user_id='editor'",
      )
    ).rows.length,
    0,
  );
});

test('the database keeps exactly one owner through transfer, removal, account deletion and collection deletion', async (t) => {
  const { client, db, cleanup } = await collectionFixture();
  t.after(cleanup);
  await enrollNewUser(db, 'owner');
  await client.execute(
    "INSERT INTO collections(id,name,owner_user_id,is_personal,created_at,updated_at) VALUES('x','X','editor',0,0,0)",
  );
  await assert.rejects(
    client.execute(
      "DELETE FROM collection_members WHERE collection_id='x' AND user_id='editor'",
    ),
    /ownership/,
  );
  await assert.rejects(
    client.execute(
      "UPDATE collection_members SET role='viewer' WHERE collection_id='x' AND user_id='editor'",
    ),
    /ownership/,
  );
  await assert.rejects(
    client.execute("DELETE FROM users WHERE id='editor'"),
    /owned collections/,
  );
  await client.execute(
    "UPDATE collections SET owner_user_id='viewer' WHERE id='x'",
  );
  await assert.rejects(
    client.execute(
      "DELETE FROM collection_members WHERE collection_id='x' AND user_id='viewer'",
    ),
    /ownership/,
  );
  assert.deepEqual(
    (
      await client.execute(
        "SELECT user_id,role FROM collection_members WHERE collection_id='x' ORDER BY user_id",
      )
    ).rows.map((row) => [row.user_id, row.role]),
    [
      ['editor', 'editor'],
      ['viewer', 'owner'],
    ],
  );
  await client.execute("DELETE FROM collections WHERE id='x'");
  await assert.rejects(
    client.execute('DELETE FROM collections WHERE is_default=1'),
    /another default/,
  );
});

test('editors manage other creators books and moves require both collections while preserving reading data', async (t) => {
  const { client, db, cleanup } = await collectionFixture();
  t.after(cleanup);
  await enrollNewUser(db, 'owner');
  await enrollNewUser(db, 'editor');
  const source = await resolveBookTarget(db, 'editor');
  await client.execute({
    sql: "INSERT INTO books(id,title,collection_id,created_by_user_id,created_at,updated_at) VALUES('book','Book',?,'viewer',0,0)",
    args: [source],
  });
  await client.execute(
    "INSERT INTO user_book_status(user_id,book_id,status,updated_at) VALUES('editor','book','reading',0)",
  );
  await client.execute({
    sql: "INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES(?,'viewer','viewer',0)",
    args: [source],
  });
  await assertBookEditor(db, 'editor', 'book');
  await assert.rejects(
    assertBookEditor(db, 'viewer', 'book'),
    /Owner or editor/,
  );
  await client.execute(
    "INSERT INTO collections(id,name,owner_user_id,is_personal,created_at,updated_at) VALUES('dest','Destination','owner',0,0,0)",
  );
  await assert.rejects(
    moveCollectionBooks(db, 'editor', ['book'], 'dest'),
    /Owner or editor/,
  );
  await client.execute(
    "INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES('dest','editor','editor',0)",
  );
  assert.equal(await moveCollectionBooks(db, 'editor', ['book'], 'dest'), 1);
  assert.equal(
    (
      await client.execute(
        "SELECT collection_id FROM collection_books WHERE book_id='book'",
      )
    ).rows[0]?.collection_id,
    'dest',
  );
  assert.equal(
    (
      await client.execute(
        "SELECT status FROM user_book_status WHERE book_id='book'",
      )
    ).rows[0]?.status,
    'reading',
  );
  await assert.rejects(
    client.execute("DELETE FROM collections WHERE id='dest'"),
    /empty the collection/,
  );
  await assert.rejects(
    client.execute(
      "INSERT INTO collection_books(collection_id,book_id) VALUES('dest','book')",
    ),
    /view/,
  );
});

test('health reports cross-collection matching entries without requiring memberships for every user', async (t) => {
  const { client, db, cleanup } = await collectionFixture();
  t.after(cleanup);
  await enrollNewUser(db, 'owner');
  const first = await resolveBookTarget(db, 'owner');
  await client.execute(
    "INSERT INTO collections(id,name,owner_user_id,is_personal,created_at,updated_at) VALUES('private','Private','owner',0,0,0)",
  );
  await client.execute({
    sql: "INSERT INTO books(id,title,collection_id,created_at,updated_at) VALUES('one','Dune',?,0,0),('two','Dune','private',0,0)",
    args: [first],
  });
  const checks = await collectionHealth(db, 20);
  const duplicates = checks.find(
    (check) => check.id === 'duplicates.cross-collection-titles',
  );
  assert.equal(duplicates?.status, 'warn');
  assert.equal(duplicates?.meta?.duplicateGroupCount, 1);
  assert.match(JSON.stringify(duplicates?.sample), /Private/);
  assert.match(JSON.stringify(duplicates?.sample), /Default/);
  assert.ok(!checks.some((check) => check.id.includes('missing-personal')));
  assert.equal(
    (
      await client.execute(
        "SELECT count(*) AS n FROM collection_members WHERE user_id='viewer'",
      )
    ).rows[0]?.n,
    0,
  );
});
