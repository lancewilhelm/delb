import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { moveStoredFiles } from '../../../server/utils/books/storage/move-operation.ts';
const root = path.resolve('library');
const dir = path.join(root, 'synthetic-restart-regression');
const source = path.join(dir, 'source.bin');
const destination = path.join(dir, 'destination.bin');
if (process.argv[2] === 'prepare') {
  await mkdir(dir, { recursive: false });
  await writeFile(source, 'synthetic original bytes');
  await assert.rejects(
    moveStoredFiles({
      root,
      bookId: 'synthetic-restart-regression',
      entries: [{ source, destination }],
      decision: { isCommitted: async () => false, remove: async () => {} },
      commit: async () => {
        throw Error('injected commit failure');
      },
    }),
  );
  await writeFile(destination, 'partial');
  console.log(
    'Prepared a synthetic interrupted uncommitted move; restart the disposable server next.',
  );
} else {
  const response = await fetch('http://127.0.0.1:4317/api/books', {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 401);
  assert.equal(await readFile(source, 'utf8'), 'synthetic original bytes');
  assert.equal(await readFile(destination, 'utf8'), 'partial');
  assert.ok(
    (await readdir(root)).some((name) => name.startsWith('.delb-failed-move-')),
  );
  console.log(
    'PASS Nitro startup remains available and preserves original plus partial move bytes',
  );
}
