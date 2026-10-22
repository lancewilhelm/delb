import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { createPinia, defineStore } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';

// Use Pinia's Vue peer under pnpm's isolated dependency layout.
const { createApp, ref } = createRequire(import.meta.resolve('pinia'))('vue');

function createStore(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const code = transformSync(
    readFileSync(new URL('./ui.ts', import.meta.url), 'utf8').replace(
      "import { defineStore } from 'pinia';",
      '',
    ),
    { loader: 'ts', format: 'cjs' },
  ).code;
  const module = { exports: {} as typeof import('./ui') };
  runInNewContext(code, { module, exports: module.exports, defineStore, ref });
  const pinia = createPinia();
  pinia.use(createPersistedState({ storage }));
  createApp({}).use(pinia);
  return module.exports.useUiStore(pinia);
}

test('page sort defaults, direction toggling and actual preference persistence', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const store = createStore(storage);
  assert.equal(store.booksSortKey, 'dateAdded');
  assert.equal(store.booksSortDirection, 'desc');
  store.setBooksSortKey('pages');
  assert.equal(store.booksSortDirection, 'asc');
  store.toggleBooksSortDirection();
  assert.equal(store.booksSortDirection, 'desc');
  store.$persist();
  const hydrated = createStore(storage);
  assert.equal(hydrated.booksSortKey, 'pages');
  assert.equal(hydrated.booksSortDirection, 'desc');
  for (const [key, direction] of [
    ['alphabetical', 'asc'],
    ['publishedDate', 'desc'],
    ['dateAdded', 'desc'],
  ] as const) {
    hydrated.setBooksSortKey(key);
    assert.equal(hydrated.booksSortDirection, direction);
  }
  hydrated.$reset();
  assert.equal(hydrated.booksSortKey, 'dateAdded');
  assert.equal(hydrated.booksSortDirection, 'desc');
});
