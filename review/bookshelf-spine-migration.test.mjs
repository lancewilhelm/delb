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

test('upgrading preserves artwork and makes revision lookup independent of artwork rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delb-spine-migration-'));
  const oldMigrations = join(directory, 'old');
  const source = '.drizzle/migrations';
  const journal = JSON.parse(
    await readFile(join(source, 'meta/_journal.json'), 'utf8'),
  );
  const migrationIndex = journal.entries.findIndex(
    (entry) => entry.tag === '0012_special_tiger_shark',
  );
  assert.ok(migrationIndex > 0, 'The spine index migration is in the journal');
  const oldJournal = {
    ...journal,
    entries: journal.entries.slice(0, migrationIndex),
  };
  await mkdir(join(oldMigrations, 'meta'), { recursive: true });
  await writeFile(
    join(oldMigrations, 'meta/_journal.json'),
    JSON.stringify(oldJournal),
  );
  for (const entry of oldJournal.entries) {
    await copyFile(
      join(source, `${entry.tag}.sql`),
      join(oldMigrations, `${entry.tag}.sql`),
    );
  }
  const client = createClient({ url: `file:${join(directory, 'fixture.db')}` });
  try {
    await migrate(drizzle(client), { migrationsFolder: oldMigrations });
    await client.execute('PRAGMA foreign_keys=OFF');
    await client.execute({
      sql: 'INSERT INTO book_spines VALUES (?, ?, ?, ?, ?, ?)',
      args: [
        'synthetic-book',
        'original',
        'image/png',
        'edited',
        '{}',
        'revision-one',
      ],
    });
    await migrate(drizzle(client), { migrationsFolder: source });
    const row = await client.execute(
      'SELECT original_base64, image_base64, revision FROM book_spines',
    );
    assert.deepEqual(
      [
        row.rows[0].original_base64,
        row.rows[0].image_base64,
        row.rows[0].revision,
      ],
      ['original', 'edited', 'revision-one'],
    );
    const plan = await client.execute({
      sql: 'EXPLAIN QUERY PLAN SELECT revision FROM book_spines INDEXED BY book_spines_book_revision_idx WHERE book_id=?',
      args: ['synthetic-book'],
    });
    assert.ok(
      plan.rows.some((item) => String(item.detail).includes('COVERING INDEX')),
    );
    await client.execute(
      "UPDATE book_spines SET revision='revision-two' WHERE book_id='synthetic-book'",
    );
    const revision = await client.execute(
      "SELECT revision FROM book_spines INDEXED BY book_spines_book_revision_idx WHERE book_id='synthetic-book'",
    );
    assert.equal(revision.rows[0].revision, 'revision-two');
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
