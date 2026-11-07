import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { createPinia, defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Collection } from './collections';

function fixture() {
  let rows: Collection[] = [
    {
      id: 'default',
      name: 'Default',
      role: 'editor',
      ownerUserId: 'owner',
      isDefault: true,
    },
    {
      id: 'other',
      name: 'Other',
      role: 'owner',
      ownerUserId: 'me',
      isDefault: false,
    },
  ];
  let failDefault = false;
  const source = readFileSync(
    new URL('./collections.ts', import.meta.url),
    'utf8',
  ).replace("import { defineStore } from 'pinia';", '');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as typeof import('./collections') };
  runInNewContext(code, {
    module,
    exports: module.exports,
    ref,
    computed,
    defineStore,
    $fetch: async (
      url: string,
      options: { method: string; body?: { collectionId?: string } },
    ) => {
      if (url === '/api/collections')
        return { success: true, data: { collections: rows } };
      if (failDefault) throw new Error('Forbidden');
      rows = rows.map((row) => ({
        ...row,
        isDefault: row.id === options.body?.collectionId,
      }));
      return { success: true };
    },
  });
  return {
    store: module.exports.useCollectionsStore(createPinia()),
    setRows: (value: Collection[]) => {
      rows = value;
    },
    fail: () => {
      failDefault = true;
    },
  };
}

test('fresh browsing starts in the default and preserves subsequent selections during refresh', async () => {
  const { store } = fixture();
  // Simulate a persisted selection from an earlier app load.
  store.activeSelection = { kind: 'collection', collectionId: 'other' };
  await store.fetchCollections();
  assert.equal(store.activeCollectionId, 'default');
  store.setActiveAll();
  await store.fetchCollections();
  assert.equal(store.activeCollectionId, null);
  store.setActiveCollection('other');
  await store.fetchCollections();
  assert.equal(store.activeCollectionId, 'other');
  store.$reset();
  await store.fetchCollections();
  assert.equal(store.activeCollectionId, 'default');
});

test('changing the default immediately updates browsing and a failed save leaves the previous default', async () => {
  const { store, fail } = fixture();
  await store.fetchCollections();
  await store.setDefaultCollection('other');
  assert.equal(store.activeCollectionId, 'other');
  assert.equal(store.collections.find((row) => row.isDefault)?.id, 'other');
  fail();
  await assert.rejects(store.setDefaultCollection('default'), /Forbidden/);
  assert.equal(store.activeCollectionId, 'other');
  assert.equal(store.collections.find((row) => row.isDefault)?.id, 'other');
});

test('readers without default membership fall back to All without gaining access', async () => {
  const { store, setRows } = fixture();
  setRows([]);
  await store.fetchCollections();
  assert.equal(store.activeCollectionId, null);
  assert.equal(store.collections.length, 0);
});
