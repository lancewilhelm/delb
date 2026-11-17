import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

test('upgrade preserves existing MCP connection and keeps metadata edits disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delb-mcp-upgrade-'));
  const source = '.drizzle/migrations';
  const old = join(directory, 'old');
  const journal = JSON.parse(
    await readFile(join(source, 'meta/_journal.json'), 'utf8'),
  );
  const index = journal.entries.findIndex(
    (entry) => entry.tag === '0018_bright_madame_hydra',
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
    await client.execute(
      "INSERT INTO users(id,name,email,email_verified,created_at,updated_at,role) VALUES('u','User','user@example.invalid',0,1,1,'user')",
    );
    await client.execute(
      "INSERT INTO mcp_connections(id,user_id,name,digest,can_write,created_at,expires_at) VALUES('c','u','Hermes','existing-digest',1,1,9999999999999)",
    );
    await migrate(drizzle(client), { migrationsFolder: source });
    const [row] = (
      await client.execute(
        'SELECT name,digest,can_write,can_edit_metadata FROM mcp_connections',
      )
    ).rows;
    assert.equal(row.name, 'Hermes');
    assert.equal(row.digest, 'existing-digest');
    assert.equal(row.can_write, 1);
    assert.equal(row.can_edit_metadata, 0);
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
