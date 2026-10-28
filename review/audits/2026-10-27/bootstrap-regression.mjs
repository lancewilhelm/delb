import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';

assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
try {
  assert.equal(
    (await db.execute('SELECT count(*) AS n FROM users')).rows[0].n,
    0,
  );
  const results = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      fetch('http://127.0.0.1:4317/api/auth/sign-up/email', {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          Origin: 'http://127.0.0.1:4317',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `Bootstrap ${i}`,
          email: `bootstrap-${i}-${randomBytes(4).toString('hex')}@example.invalid`,
          password: randomBytes(20).toString('hex'),
        }),
      }),
    ),
  );
  const statuses = results.map((result) => result.status);
  assert.ok(statuses.includes(200), `No signup succeeded: ${statuses}`);
  const owners = await db.execute("SELECT id FROM users WHERE role = 'owner'");
  assert.equal(owners.rows.length, 1);
  assert.equal(
    (
      await db.execute(
        "SELECT value FROM system_state WHERE key = 'owner-bootstrap'",
      )
    ).rows[0]?.value,
    'complete',
  );
  await db.execute({
    sql: 'DELETE FROM users WHERE id = ?',
    args: [owners.rows[0].id],
  });
  const later = await fetch('http://127.0.0.1:4317/api/auth/sign-up/email', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: {
      Origin: 'http://127.0.0.1:4317',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Later signup',
      email: `later-${randomBytes(4).toString('hex')}@example.invalid`,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(later.status, 200);
  assert.equal(
    (await db.execute("SELECT id FROM users WHERE role = 'owner'")).rows.length,
    0,
  );
  console.log(
    'Concurrent signup statuses:',
    statuses.join(', '),
    '; one owner and durable marker',
  );
} finally {
  db.close();
}
