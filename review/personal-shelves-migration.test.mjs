import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

test('existing bookshelf and artwork survive the personal Shelves migration', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'delb-personal-shelves-upgrade-'),
  );
  const source = '.drizzle/migrations';
  const old = join(directory, 'old');
  const journal = JSON.parse(
    await readFile(join(source, 'meta/_journal.json'), 'utf8'),
  );
  const index = journal.entries.findIndex(
    (entry) => entry.tag === '0013_cool_lila_cheney',
  );
  assert.ok(index > 0);
  const prior = { ...journal, entries: journal.entries.slice(0, index) };
  await mkdir(join(old, 'meta'), { recursive: true });
  await writeFile(join(old, 'meta/_journal.json'), JSON.stringify(prior));
  for (const entry of prior.entries)
    await copyFile(
      join(source, `${entry.tag}.sql`),
      join(old, `${entry.tag}.sql`),
    );
  const client = createClient({ url: `file:${join(directory, 'fixture.db')}` });
  try {
    await migrate(drizzle(client), { migrationsFolder: old });
    await client.execute('PRAGMA foreign_keys=OFF');
    await client.execute({
      sql: 'INSERT INTO book_spines VALUES (?, ?, ?, ?, ?, ?)',
      args: ['book', 'original', 'image/png', 'edited', '{}', 'revision'],
    });
    await client.execute({
      sql: 'INSERT INTO collection_bookshelves VALUES (?, ?, ?)',
      args: ['collection', 3, '{"bookcases":[]}'],
    });
    await migrate(drizzle(client), { migrationsFolder: source });
    assert.equal(
      (await client.execute('SELECT original_base64 FROM book_spines')).rows[0]
        .original_base64,
      'original',
    );
    assert.equal(
      (await client.execute('SELECT revision FROM collection_bookshelves'))
        .rows[0].revision,
      3,
    );
    await client.execute('PRAGMA foreign_keys=OFF');
    await client.execute({
      sql: 'INSERT INTO personal_shelves(id,owner_id,name,revision,geometry,created_at) VALUES (?,?,?,?,?,?)',
      args: ['shelf', 'owner', 'Favorites', 0, '{"bookcases":[]}', 1],
    });
    await client.execute({
      sql: 'INSERT INTO personal_shelf_books(shelf_id,book_id,placement,added_at) VALUES (?,?,?,?)',
      args: ['shelf', 'book', null, 1],
    });
    assert.equal(
      (await client.execute('SELECT count(*) AS n FROM personal_shelf_books'))
        .rows[0].n,
      1,
    );
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
