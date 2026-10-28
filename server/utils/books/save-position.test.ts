import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { savePosition } from './save-position';

test('position writes reject older same-session updates and preserve legacy and cross-session behavior', async () => {
  const client = createClient({ url: 'file::memory:' });
  await client.execute(
    'CREATE TABLE user_book_reading_position (user_id TEXT NOT NULL, book_id TEXT NOT NULL, location TEXT NOT NULL, progress REAL, updated_at INTEGER NOT NULL, UNIQUE(user_id, book_id))',
  );
  const migration = await readFile(
    '.drizzle/migrations/0004_light_wallow.sql',
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    await client.execute(statement.trim());
  }
  const db = drizzle(client);
  const base = {
    userId: 'u',
    bookId: 'b',
    location: 'new',
    progress: 20,
    clientSessionId: 'a',
    clientSequence: 2,
  };
  assert.equal((await savePosition(db, base)).accepted, true);
  const stale = await savePosition(db, {
    ...base,
    location: 'old',
    progress: 10,
    clientSequence: 1,
  });
  assert.deepEqual(stale, {
    accepted: false,
    position: { location: 'new', progress: 20 },
  });
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      savePosition(db, {
        ...base,
        location: String(i + 3),
        clientSequence: i + 3,
      }),
    ),
  );
  assert.ok(results.some((result) => result.accepted));
  const current = await savePosition(db, {
    ...base,
    location: 'stale',
    clientSequence: 1,
  });
  assert.deepEqual(current.position, { location: '22', progress: 20 });
  assert.equal(
    (
      await savePosition(db, {
        ...base,
        clientSessionId: 'b',
        clientSequence: 1,
      })
    ).accepted,
    true,
  );
  assert.equal(
    (
      await savePosition(db, {
        ...base,
        clientSessionId: null,
        clientSequence: null,
      })
    ).accepted,
    true,
  );
  client.close();
});
