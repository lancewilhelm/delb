import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue';
import { useEntityPagination } from './useEntityPagination';

type Node = { children: Node[] };
const renderer = createRenderer<Node, Node>({
  createElement: () => ({ children: [] }),
  createText: () => ({ children: [] }),
  createComment: () => ({ children: [] }),
  setText: () => {},
  setElementText: () => {},
  parentNode: () => null,
  nextSibling: () => null,
  patchProp: () => {},
  insert: (child, parent) => {
    parent.children.push(child);
  },
  remove: () => {},
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await nextTick();
}

test('pagination snapshots inputs, prevents duplicate requests, and ignores stale outcomes', async () => {
  const search = ref('');
  const collection = ref('one');
  const preview = ref(8);
  const initialization = deferred<undefined>();
  const calls: {
    query: Record<string, string>;
    result: ReturnType<typeof deferred<{ rows: string[]; hasMore: boolean }>>;
  }[] = [];
  let pagination!: ReturnType<typeof useEntityPagination<string>>;
  const app = renderer.createApp(
    defineComponent({
      setup() {
        pagination = useEntityPagination({
          inputs: () => ({
            search: search.value,
            collectionId: collection.value,
            previewLimit: preview.value,
          }),
          initialize: () => initialization.promise,
          fetchPage: (query) => {
            const result = deferred<{ rows: string[]; hasMore: boolean }>();
            calls.push({ query, result });
            return result.promise;
          },
          failureMessage: 'Failed',
        });
        return () => h('div');
      },
    }),
  );
  app.mount({ children: [] });
  assert.equal(pagination.loading.value, true);
  assert.equal(calls.length, 0);
  collection.value = 'two';
  initialization.resolve(undefined);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(pagination.loading.value, true);
  assert.equal(calls[0]!.query.collectionId, 'two');
  calls[0]!.result.resolve({ rows: ['a', 'b'], hasMore: true });
  await settle();
  assert.equal(pagination.loading.value, false);
  void pagination.loadMore();
  void pagination.loadMore();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.query.offset, '2');
  search.value = 'new';
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.query.search, 'new');
  calls[1]!.result.reject(new Error('old failure'));
  await settle();
  assert.equal(pagination.loading.value, true);
  assert.equal(pagination.error.value, null);
  collection.value = 'three';
  assert.equal(calls.length, 4);
  calls[2]!.result.resolve({ rows: ['stale'], hasMore: true });
  calls[3]!.result.resolve({ rows: ['fresh'], hasMore: true });
  await settle();
  assert.deepEqual(pagination.rows.value, ['fresh']);
  assert.equal(calls[3]!.query.collectionId, 'three');
  preview.value = 4;
  assert.equal(calls[4]!.query.previewLimit, '4');
  app.unmount();
  calls[4]!.result.resolve({ rows: ['unmounted'], hasMore: false });
  await settle();
  assert.deepEqual(pagination.rows.value, []);
});

test('initial request failure ends loading and reports the error', async () => {
  const request = deferred<{ rows: string[]; hasMore: boolean }>();
  let pagination!: ReturnType<typeof useEntityPagination<string>>;
  const app = renderer.createApp(
    defineComponent({
      setup() {
        pagination = useEntityPagination({
          inputs: () => ({ search: '', previewLimit: 8 }),
          initialize: async () => {},
          fetchPage: () => request.promise,
          failureMessage: 'Failed',
        });
        return () => h('div');
      },
    }),
  );
  app.mount({ children: [] });
  await settle();
  assert.equal(pagination.loading.value, true);
  request.reject(new Error('offline'));
  await settle();
  assert.equal(pagination.loading.value, false);
  assert.equal(pagination.error.value, 'offline');
  app.unmount();
});

test('unmount during initialization does not start a request', async () => {
  const initialization = deferred<undefined>();
  let calls = 0;
  let pagination!: ReturnType<typeof useEntityPagination<string>>;
  const app = renderer.createApp(
    defineComponent({
      setup() {
        pagination = useEntityPagination({
          inputs: () => ({ search: '', previewLimit: 8 }),
          initialize: () => initialization.promise,
          fetchPage: async () => {
            calls++;
            return { rows: [], hasMore: false };
          },
          failureMessage: 'Failed',
        });
        return () => h('div');
      },
    }),
  );
  app.mount({ children: [] });
  assert.equal(pagination.loading.value, true);
  app.unmount();
  initialization.resolve(undefined);
  await settle();
  assert.equal(calls, 0);
});

test('append errors and zero progress preserve rows and allow retry', async () => {
  const calls: ReturnType<
    typeof deferred<{ rows: string[]; hasMore: boolean }>
  >[] = [];
  let pagination!: ReturnType<typeof useEntityPagination<string>>;
  const app = renderer.createApp(
    defineComponent({
      setup() {
        pagination = useEntityPagination({
          inputs: () => ({ search: '', previewLimit: 8 }),
          initialize: async () => {},
          fetchPage: () => {
            const result = deferred<{ rows: string[]; hasMore: boolean }>();
            calls.push(result);
            return result.promise;
          },
          failureMessage: 'Failed',
        });
        return () => h('div');
      },
    }),
  );
  app.mount({ children: [] });
  await settle();
  calls[0]!.resolve({ rows: ['a'], hasMore: true });
  await settle();
  void pagination.loadMore();
  calls[1]!.reject(new Error('offline'));
  await settle();
  assert.deepEqual(pagination.rows.value, ['a']);
  assert.equal(pagination.error.value, 'offline');
  void pagination.retry();
  calls[2]!.resolve({ rows: [], hasMore: true });
  await settle();
  assert.deepEqual(pagination.rows.value, ['a']);
  assert.ok(pagination.error.value);
  void pagination.retry();
  calls[3]!.resolve({ rows: ['b'], hasMore: false });
  await settle();
  assert.deepEqual(pagination.rows.value, ['a', 'b']);
  assert.equal(pagination.hasMore.value, false);
  app.unmount();
});
