import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deleteCollection } from './delete';
import { recoverStoredDeletes } from '../books/storage/delete-operation';
import { withBookStorageLock } from '../books/storage/book-lock';

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'delb-delete-collection-'),
  );
  const root = path.join(directory, 'library');
  await mkdir(path.join(root, 'deleted'), { recursive: true });
  const client = createClient({
    url: `file:${path.join(directory, 'test.db')}`,
  });
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL('../../../.drizzle/migrations', import.meta.url),
    ),
  });
  await client.executeMultiple(`
    INSERT INTO users(id,name,email,email_verified,created_at,updated_at,role) VALUES
      ('admin','Admin','admin@example.invalid',1,0,0,'owner'),
      ('owner','Owner','owner@example.invalid',1,0,0,'user'),
      ('reader','Reader','reader@example.invalid',1,0,0,'user');
    INSERT INTO collections(id,name,owner_user_id,is_personal,is_default,created_at,updated_at) VALUES
      ('default','Default','admin',0,1,0,0),('deleted','Delete me','owner',0,0,0,0),('kept','Keep me','owner',0,0,0,0);
    INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES ('deleted','reader','editor',0);
    INSERT INTO books(id,title,collection_id,cover_image_path,created_at,updated_at) VALUES
      ('a','First','deleted','library/deleted/cover.webp',0,0),
      ('b','Second','deleted',NULL,0,0),('c','Outside','kept',NULL,0,0);
    INSERT INTO book_files(id,book_id,format,relative_path,created_at) VALUES
      ('fa','a','epub','library/deleted/book.epub',0),
      ('fb','b','pdf','library/shared.pdf',0),('fc','c','pdf','library/shared.pdf',0);
    INSERT INTO user_book_status(user_id,book_id,status,updated_at) VALUES ('reader','a','reading',0);
    INSERT INTO user_book_reading_position(user_id,book_id,location,progress,updated_at) VALUES ('reader','a','chapter-1',25,0);
    INSERT INTO book_notes(id,user_id,book_id,text,created_at,updated_at) VALUES ('note','reader','a','Private note',0,0);
  `);
  for (const file of [
    'deleted/book.epub',
    'deleted/cover.webp',
    'deleted/cover.thumb.webp',
    'shared.pdf',
  ])
    await writeFile(path.join(root, file), file);
  const remove = (
    userId = 'owner',
    confirmationName = 'Delete me',
    collectionId = 'deleted',
  ) =>
    deleteCollection({
      db,
      libraryRoot: root,
      userId,
      confirmationName,
      collectionId,
    });
  return {
    client,
    root,
    remove,
    cleanup: async () => {
      client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('collection deletion removes its books, files, thumbnails and reading data while preserving other collections', async (t) => {
  const { client, root, remove, cleanup } = await fixture();
  t.after(cleanup);
  assert.deepEqual(await remove(), { deletedBooks: 2 });
  assert.equal(
    (await client.execute("SELECT id FROM collections WHERE id='deleted'")).rows
      .length,
    0,
  );
  assert.deepEqual(
    (await client.execute('SELECT id FROM books')).rows.map((row) => row.id),
    ['c'],
  );
  for (const table of [
    'user_book_status',
    'user_book_reading_position',
    'book_notes',
  ])
    assert.equal(
      (await client.execute(`SELECT * FROM ${table}`)).rows.length,
      0,
    );
  for (const file of [
    'deleted/book.epub',
    'deleted/cover.webp',
    'deleted/cover.thumb.webp',
  ])
    await assert.rejects(readFile(path.join(root, file)), { code: 'ENOENT' });
  assert.equal(
    await readFile(path.join(root, 'shared.pdf'), 'utf8'),
    'shared.pdf',
  );
  assert.equal(
    (await client.execute('SELECT * FROM storage_operations')).rows.length,
    0,
  );
});

test('editors, stale confirmations and the current default cannot delete collections', async (t) => {
  const { client, root, remove, cleanup } = await fixture();
  t.after(cleanup);
  await assert.rejects(remove('reader'), { statusCode: 403 });
  await assert.rejects(remove('owner', 'Wrong name'), { statusCode: 409 });
  await assert.rejects(remove('admin', 'Default', 'default'), {
    statusCode: 409,
  });
  assert.equal(
    (await client.execute("SELECT id FROM books WHERE collection_id='deleted'"))
      .rows.length,
    2,
  );
  assert.equal(
    await readFile(path.join(root, 'deleted/book.epub'), 'utf8'),
    'deleted/book.epub',
  );
});

test('a failed collection commit rolls back every book and preserves original bytes through recovery', async (t) => {
  const { client, root, remove, cleanup } = await fixture();
  t.after(cleanup);
  await client.execute(
    "CREATE TRIGGER fail_collection_delete BEFORE DELETE ON collections WHEN OLD.id='deleted' BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  await assert.rejects(
    remove(),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      /injected failure/.test(error.cause.message),
  );
  assert.equal(
    (await client.execute("SELECT id FROM books WHERE collection_id='deleted'"))
      .rows.length,
    2,
  );
  assert.equal(
    (await client.execute('SELECT * FROM book_notes')).rows.length,
    1,
  );
  assert.equal(
    (await client.execute('SELECT * FROM storage_operations')).rows.length,
    0,
  );
  await recoverStoredDeletes({
    root,
    decision: { isCommitted: async () => false, remove: async () => {} },
    withLock: async (_id, work) => work(),
  });
  assert.equal(
    await readFile(path.join(root, 'deleted/book.epub'), 'utf8'),
    'deleted/book.epub',
  );
  await client.execute('DROP TRIGGER fail_collection_delete');
  assert.deepEqual(await remove('admin'), { deletedBooks: 2 });
});

test('a book moved while deletion waits for storage is preserved and the collection remains', async (t) => {
  const { client, root, remove, cleanup } = await fixture();
  t.after(cleanup);
  let release = () => {};
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = withBookStorageLock(root, 'b', async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
      started();
    });
  });
  await ready;
  const deletion = assert.rejects(remove(), { statusCode: 409 });
  try {
    const lockFile = path.join(
      root,
      '.delb-locks',
      createHash('sha256').update('a').digest('hex') + '.db',
    );
    let snapshotCaptured = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await access(lockFile);
        snapshotCaptured = true;
        break;
      } catch {
        await delay(10);
      }
    }
    assert.ok(snapshotCaptured, 'deletion reached the first book storage lock');
    await client.execute("UPDATE books SET collection_id='kept' WHERE id='b'");
  } finally {
    release();
    await held;
    await deletion;
  }
  assert.equal(
    (await client.execute("SELECT id FROM collections WHERE id='deleted'")).rows
      .length,
    1,
  );
  assert.equal(
    (await client.execute("SELECT collection_id FROM books WHERE id='b'"))
      .rows[0]?.collection_id,
    'kept',
  );
  assert.equal(
    await readFile(path.join(root, 'deleted/book.epub'), 'utf8'),
    'deleted/book.epub',
  );
});
