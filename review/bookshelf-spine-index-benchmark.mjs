import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// Synthetic-only comparison; neither side touches an existing Delb database.
const directory = await mkdtemp(join(tmpdir(), 'delb-spine-index-'));
try {
  const beforePath = join(directory, 'before.db');
  const afterPath = join(directory, 'after.db');
  const setup = new DatabaseSync(beforePath);
  setup.exec(`
    CREATE TABLE books(id TEXT PRIMARY KEY, collection_id TEXT NOT NULL);
    CREATE INDEX books_collection_idx ON books(collection_id);
    CREATE TABLE book_spines(book_id TEXT PRIMARY KEY, original_base64 TEXT NOT NULL,
      original_type TEXT NOT NULL, image_base64 TEXT NOT NULL, edits TEXT NOT NULL, revision TEXT NOT NULL);
    BEGIN;
  `);
  const book = setup.prepare('INSERT INTO books VALUES (?, ?)');
  const spine = setup.prepare(
    'INSERT INTO book_spines VALUES (?, ?, ?, ?, ?, ?)',
  );
  const image = 'x'.repeat(1_000_000);
  for (let i = 0; i < 804; i++) {
    book.run(`book-${i}`, 'collection');
    if (i < 101)
      spine.run(`book-${i}`, image, 'image/webp', image, '{}', `revision-${i}`);
  }
  setup.exec('COMMIT');
  setup.close();
  await copyFile(beforePath, afterPath);
  const before = new DatabaseSync(beforePath);
  const after = new DatabaseSync(afterPath);
  try {
    after.exec(
      'CREATE INDEX book_spines_book_revision_idx ON book_spines(book_id, revision)',
    );
    const beforeSql = `SELECT b.id, s.revision FROM books b
      LEFT JOIN book_spines s ON s.book_id=b.id WHERE b.collection_id=? ORDER BY b.id`;
    const afterSql = `SELECT b.id, (SELECT revision FROM book_spines INDEXED BY book_spines_book_revision_idx
      WHERE book_id=b.id) AS revision FROM books b WHERE b.collection_id=? ORDER BY b.id`;
    const plan = after
      .prepare(`EXPLAIN QUERY PLAN ${afterSql}`)
      .all('collection');
    assert.ok(
      plan.some((row) =>
        String(row.detail).includes(
          'COVERING INDEX book_spines_book_revision_idx',
        ),
      ),
    );
    const queries = {
      before: before.prepare(beforeSql),
      after: after.prepare(afterSql),
    };
    const samples = { before: [], after: [] };
    let expected;
    for (let i = 0; i < 7; i++) {
      for (const side of i % 2 ? ['after', 'before'] : ['before', 'after']) {
        const start = performance.now();
        const rows = queries[side].all('collection');
        samples[side].push(Math.round((performance.now() - start) * 10) / 10);
        assert.equal(rows.length, 804);
        assert.equal(rows.filter((row) => row.revision !== null).length, 101);
        const result = JSON.stringify(rows);
        expected ??= result;
        assert.equal(result, expected);
      }
    }
    console.log(
      JSON.stringify({
        books: 804,
        artwork: 101,
        imageBytesPerRow: 2_000_000,
        samplesMs: samples,
      }),
    );
  } finally {
    before.close();
    after.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
