import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNoEnvironmentFiles, assertEmptyStorage } from './isolation.mjs';

async function inDisposableDirectory(check) {
  const previous = process.cwd();
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'delb-review-isolation-'),
  );
  try {
    process.chdir(directory);
    await check();
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true });
  }
}

test('demo refuses environment files without reading them', async () => {
  await inDisposableDirectory(async () => {
    await writeFile('.env.example', 'synthetic example');
    await assertNoEnvironmentFiles();
    await writeFile('.env', 'synthetic placeholder');
    await assert.rejects(
      assertNoEnvironmentFiles(),
      /without environment files/,
    );
  });
});

test('demo refuses nonempty book storage', async () => {
  await inDisposableDirectory(async () => {
    await mkdir('library');
    await writeFile('library/.gitkeep', '');
    await assertEmptyStorage();
    await writeFile('library/synthetic.epub', 'synthetic placeholder');
    await assert.rejects(assertEmptyStorage(), /library is not empty/);
  });
});

test('setup refuses an existing disposable database', async () => {
  await inDisposableDirectory(async () => {
    await mkdir('review/demo', { recursive: true });
    await writeFile('review/demo/synthetic.db', 'synthetic placeholder');
    await assert.rejects(assertEmptyStorage(), /database already exists/);
  });
});
