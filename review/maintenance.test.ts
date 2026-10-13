import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { backfillPublishedAt } from '../scripts/backfill-published-at';

test('explicit backfill preserves publication sorting values using a disposable database', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'delb-review-db-'));
  const url = `file:${path.join(temp, 'synthetic.db')}`;
  const client = createClient({ url });
  try {
    await client.execute(
      'CREATE TABLE books (id TEXT PRIMARY KEY, published TEXT, published_at INTEGER)',
    );
    for (const [id, published, publishedAt] of [
      ['day', '2024-06-15', null],
      ['month', '2024-06', null],
      ['year', '2024', null],
      ['existing', '2024', 123],
      ['invalid', 'unknown', null],
      ['empty', '', null],
    ]) {
      await client.execute({
        sql: 'INSERT INTO books VALUES (?, ?, ?)',
        args: [id, published, publishedAt],
      });
    }
    await backfillPublishedAt(url);
    const rows = (
      await client.execute('SELECT id, published_at FROM books ORDER BY id')
    ).rows;
    const values = Object.fromEntries(
      rows.map((row) => [row.id, row.published_at]),
    );
    assert.deepEqual(values, {
      day: Date.parse('2024-06-15T00:00:00Z'),
      month: Date.parse('2024-06-01T00:00:00Z'),
      year: Date.parse('2024-01-01T00:00:00Z'),
      existing: 123,
      invalid: null,
      empty: null,
    });
    await assert.rejects(
      backfillPublishedAt('https://example.invalid'),
      /explicit file/,
    );
  } finally {
    client.close();
    await rm(temp, { recursive: true });
  }
});
