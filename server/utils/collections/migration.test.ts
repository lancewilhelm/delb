import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  applyCollectionMigration,
  previewCollectionMigration,
} from './migration';

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'delb-collection-migration-'),
  );
  const client = createClient({
    url: `file:${path.join(directory, 'test.db')}`,
  });
  const migrations = fileURLToPath(
    new URL('../../../.drizzle/migrations/', import.meta.url),
  );
  const files = (await readdir(migrations))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files.filter((file) => !file.startsWith('0007')))
    for (const statement of (
      await readFile(path.join(migrations, file), 'utf8')
    ).split('--> statement-breakpoint'))
      if (statement.trim()) await client.execute(statement);
  for (const statement of [
    "INSERT INTO users(id,name,email,email_verified,created_at,updated_at,role) VALUES('o','Owner','o@example.invalid',1,0,0,'owner'),('u','Reader','u@example.invalid',1,0,0,'user'),('former','Former','former@example.invalid',1,0,0,'user')",
    "INSERT INTO collections(id,name,owner_user_id,is_personal,created_at,updated_at) VALUES('a','Personal','o',1,0,0),('b','Shared','o',0,0,0)",
    "INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES('a','o','owner',0),('b','o','owner',0),('a','u','viewer',0),('b','u','editor',0)",
    "INSERT INTO books(id,title,calibre_book_id,created_by_user_id,cover_image_path,created_at,updated_at) VALUES('first','First',7,'o','library/source/cover.webp',0,0),('second','Second',NULL,'o',NULL,0,0),('orphan','Orphan',NULL,'o',NULL,0,0)",
    "INSERT INTO collection_books(collection_id,book_id,added_by_user_id,added_at) VALUES('a','first','o',0),('b','first','o',0),('a','second','o',0)",
    "INSERT INTO book_files(id,book_id,format,relative_path,created_at) VALUES('f','first','epub','library/source/book.epub',0)",
    "INSERT INTO user_book_status(user_id,book_id,status,tbr_rank,updated_at) VALUES('u','first','to_be_read',1,0),('u','second','to_be_read',2,0),('former','first','reading',NULL,0)",
    "INSERT INTO user_book_rationale(user_id,book_id,text) VALUES('u','first','Read this next')",
    "INSERT INTO user_book_reading_position(user_id,book_id,location,progress,client_sequence,updated_at) VALUES('u','first','chapter-one',25,4,0)",
    "INSERT INTO user_book_progress_log(id,user_id,book_id,progress_percent,source,occurred_at,created_at) VALUES('p','u','first',25,'manual',0,0)",
    "INSERT INTO book_notes(id,user_id,book_id,text,created_at,updated_at) VALUES('n','u','first','Private note',0,0)",
    "INSERT INTO book_ratings(user_id,book_id,rating,updated_at) VALUES('u','first',8,0)",
  ])
    await client.execute(statement);
  for (const statement of (
    await readFile(
      path.join(
        migrations,
        files.find((file) => file.startsWith('0007')) ?? '',
      ),
      'utf8',
    )
  ).split('--> statement-breakpoint'))
    if (statement.trim()) await client.execute(statement);
  const library = path.join(directory, 'library');
  await mkdir(path.join(library, 'source'), { recursive: true });
  await writeFile(path.join(library, 'source/book.epub'), 'ebook bytes');
  await writeFile(path.join(library, 'source/cover.webp'), 'cover bytes');
  await writeFile(
    path.join(library, 'source/cover.thumb.webp'),
    'thumbnail bytes',
  );
  return {
    client,
    db: drizzle(client),
    library,
    cleanup: async () => {
      client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('migration preview and backup gate precede changes, then split entries preserve access, files, history and queue order', async (t) => {
  const { client, db, library, cleanup } = await fixture();
  t.after(cleanup);
  const preview = await previewCollectionMigration(db);
  assert.equal(preview.state, 'pending');
  assert.equal(preview.splits.length, 1);
  assert.equal(preview.privateCollections, 1);
  assert.equal(preview.recoveredBooks, 1);
  assert.equal(
    (await client.execute('SELECT count(*) AS n FROM books')).rows[0]?.n,
    3,
  );
  const input = {
    fingerprint: preview.fingerprint,
    choices: [{ bookId: 'first', collectionId: 'b' }],
    backupConfirmed: true,
  };
  await assert.rejects(
    applyCollectionMigration(db, library, { ...input, backupConfirmed: false }),
    /backup/,
  );
  await assert.rejects(
    applyCollectionMigration(db, library, { ...input, fingerprint: 'stale' }),
    /Preview/,
  );
  await assert.rejects(
    applyCollectionMigration(db, library, { ...input, choices: [] }),
    /every split/,
  );
  await applyCollectionMigration(db, library, input);
  const copies = (
    await client.execute(
      "SELECT id,collection_id,calibre_book_id,cover_image_path FROM books WHERE title='First' ORDER BY id",
    )
  ).rows;
  assert.equal(copies.length, 2);
  assert.deepEqual(
    new Set(copies.map((row) => row.collection_id)),
    new Set(['a', 'b']),
  );
  assert.equal(copies.find((row) => row.id === 'first')?.collection_id, 'b');
  assert.equal(copies.filter((row) => row.calibre_book_id === 7).length, 1);
  const copy = copies.find((row) => row.id !== 'first');
  assert.ok(copy);
  const copyFile = (
    await client.execute({
      sql: 'SELECT relative_path FROM book_files WHERE book_id=?',
      args: [copy.id],
    })
  ).rows[0]?.relative_path;
  assert.equal(typeof copyFile, 'string');
  assert.equal(
    await readFile(
      path.join(library, String(copyFile).slice('library/'.length)),
      'utf8',
    ),
    'ebook bytes',
  );
  assert.equal(
    await readFile(
      path.join(
        library,
        'collection-copies',
        String(copy.id),
        'cover.thumb.webp',
      ),
      'utf8',
    ),
    'thumbnail bytes',
  );
  assert.equal(
    (
      await client.execute(
        'SELECT count(*) AS n FROM collections WHERE is_personal=1',
      )
    ).rows[0]?.n,
    0,
  );
  assert.equal(
    (
      await client.execute(
        'SELECT count(*) AS n FROM collection_members cm JOIN collections c ON cm.collection_id=c.id WHERE c.is_default=1',
      )
    ).rows[0]?.n,
    3,
  );
  assert.equal(
    (
      await client.execute(
        "SELECT c.name FROM books b JOIN collections c ON c.id=b.collection_id WHERE b.id='orphan'",
      )
    ).rows[0]?.name,
    'Recovered books',
  );
  for (const table of [
    'user_book_reading_position',
    'user_book_progress_log',
    'book_notes',
    'book_ratings',
    'user_book_rationale',
  ])
    assert.equal(
      (
        await client.execute({
          sql: `SELECT count(*) AS n FROM ${table} WHERE user_id='u'`,
          args: [],
        })
      ).rows[0]?.n,
      2,
    );
  assert.equal(
    (
      await client.execute(
        "SELECT count(*) AS n FROM user_book_status WHERE user_id='former'",
      )
    ).rows[0]?.n,
    1,
  );
  const queue = (
    await client.execute(
      "SELECT book_id,tbr_rank FROM user_book_status WHERE user_id='u' ORDER BY tbr_rank",
    )
  ).rows;
  assert.deepEqual(
    queue.map((row) => row.book_id),
    ['first', copy.id, 'second'],
  );
  assert.deepEqual(
    queue.map((row) => row.tbr_rank),
    [1, 2, 3],
  );
  assert.equal((await previewCollectionMigration(db)).state, 'exclusive');
  await applyCollectionMigration(db, library, input);
  assert.equal(
    (await client.execute('SELECT count(*) AS n FROM books')).rows[0]?.n,
    4,
  );
});

test('an interrupted file copy retains the plan and resumes without duplicating data or overwriting originals', async (t) => {
  const { client, db, library, cleanup } = await fixture();
  t.after(cleanup);
  const preview = await previewCollectionMigration(db);
  const input = {
    fingerprint: preview.fingerprint,
    choices: [{ bookId: 'first', collectionId: 'a' }],
    backupConfirmed: true,
  };
  await rm(path.join(library, 'source/book.epub'));
  await assert.rejects(applyCollectionMigration(db, library, input), /ENOENT/);
  assert.equal((await previewCollectionMigration(db)).state, 'migrating');
  assert.equal(
    (await client.execute('SELECT count(*) AS n FROM books')).rows[0]?.n,
    3,
  );
  await writeFile(path.join(library, 'source/book.epub'), 'ebook bytes');
  await applyCollectionMigration(db, library, input);
  assert.equal(
    (await client.execute('SELECT count(*) AS n FROM books')).rows[0]?.n,
    4,
  );
  assert.equal(
    await readFile(path.join(library, 'source/book.epub'), 'utf8'),
    'ebook bytes',
  );
});

test('split copies preserve distinct files with the same basename and resolve legacy Dropbox destinations explicitly', async (t) => {
  const { client, db, library, cleanup } = await fixture();
  t.after(cleanup);
  await mkdir(path.join(library, 'second-source'));
  await writeFile(
    path.join(library, 'second-source/book.epub'),
    'a different edition',
  );
  await client.execute(
    "INSERT INTO book_files(id,book_id,format,relative_path,created_at) VALUES('f2','first','epub','library/second-source/book.epub',0)",
  );
  await client.execute({
    sql: "INSERT INTO global_settings(user_id,settings,updated_at) VALUES('settings',?,0)",
    args: [
      JSON.stringify({ dropbox: { additionalCollectionIds: ['a', 'b'] } }),
    ],
  });
  const preview = await previewCollectionMigration(db);
  assert.equal(preview.dropboxTargets.needsChoice, true);
  const input = {
    fingerprint: preview.fingerprint,
    choices: [{ bookId: 'first', collectionId: 'a' }],
    backupConfirmed: true,
  };
  await assert.rejects(
    applyCollectionMigration(db, library, input),
    /Dropbox destination/,
  );
  await applyCollectionMigration(db, library, {
    ...input,
    dropboxTargetId: '',
  });
  const rows = (
    await client.execute(
      "SELECT f.relative_path FROM book_files f JOIN books b ON b.id=f.book_id WHERE b.collection_id='b'",
    )
  ).rows;
  assert.equal(rows.length, 2);
  const contents = await Promise.all(
    rows.map((row) =>
      readFile(
        path.join(library, String(row.relative_path).slice('library/'.length)),
        'utf8',
      ),
    ),
  );
  assert.deepEqual(
    new Set(contents),
    new Set(['ebook bytes', 'a different edition']),
  );
  const settings = JSON.parse(
    (await client.execute('SELECT settings FROM global_settings')).rows[0]
      .settings,
  );
  assert.equal(settings.dropbox.targetCollectionId, '');
  assert.deepEqual(settings.dropbox.additionalCollectionIds, []);
});
