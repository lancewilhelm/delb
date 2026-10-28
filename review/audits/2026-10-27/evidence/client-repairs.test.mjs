import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

for (const name of ['Grid', 'List']) {
  test(`${name} retains the latest scope when responses arrive out of order`, async () => {
    const src = fs.readFileSync(
      `app/components/Books/BooksInfinite${name}.vue`,
      'utf8',
    );
    const part = src.slice(
      src.indexOf('let requestGeneration = 0;'),
      src.indexOf('\nwatch(\n', src.indexOf('async function loadNextPage')),
    );
    const requests = [];
    const c = {
      props: { collectionId: 'old', endpoint: '/books' },
      books: { value: [] },
      nextCursor: { value: null },
      errorMessage: { value: null },
      lastRangeAnchorId: { value: null },
      scrollContainerRef: { value: null },
      scrollTop: { value: 0 },
      loading: { value: false },
      limit: { value: 10 },
      debugLog() {},
      nextTick: async () => {},
      setupObserver() {},
      hasMore: { value: true },
      emit() {},
      $fetch: (url, opts) =>
        new Promise((resolve, reject) =>
          requests.push({ scope: opts.query.collectionId, resolve, reject }),
        ),
    };
    vm.createContext(c);
    vm.runInContext(
      ts.transpile(part) + ';globalThis.loadFirstPage=loadFirstPage;',
      c,
    );
    const first = c.loadFirstPage();
    c.props.collectionId = 'new';
    const second = c.loadFirstPage();
    assert.deepEqual(
      requests.map((r) => r.scope),
      ['old', 'new'],
    );
    requests[1].resolve({
      data: { books: [{ id: 'new-book' }], nextCursor: null },
    });
    await second;
    requests[0].reject(new Error('old failure'));
    await first;
    assert.equal(c.books.value[0].id, 'new-book');
    assert.equal(c.errorMessage.value, null);
    assert.equal(c.loading.value, false);
  });
}

test('settings pull keeps local edits while adopting unchanged remote fields', async () => {
  const src = fs
    .readFileSync('app/stores/userSettings.ts', 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/\bexport\s+/g, '');
  let resolve;
  const c = {
    defineStore: (id, setup) => setup,
    ref: (v) => ({ value: v }),
    computed: (f) => ({
      get value() {
        return f();
      },
    }),
    useIsMobileDevice: () => ({ value: false }),
    useAuth: () => ({ session: { value: { id: 'session' } } }),
    $fetch: (url, opts) =>
      opts.method === 'GET'
        ? new Promise((r) => {
            resolve = r;
          })
        : Promise.resolve({}),
    useDebounceFn: () => () => {},
    normalizeCustomTheme: (x) => x,
    console,
  };
  vm.createContext(c);
  vm.runInContext(
    ts.transpile(src, { target: ts.ScriptTarget.ES2020 }) +
      ';globalThis.store=useUserSettingsStore();',
    c,
  );
  const pending = c.store.pull();
  await c.store.updateSettings({ fontFamily: 'Inter' });
  resolve({
    data: {
      userSettings: {
        settings: { fontFamily: 'Nunito', fontSize: 23 },
        updatedAt: '2020-01-01',
      },
    },
  });
  await pending;
  assert.equal(c.store.settings.value.fontFamily, 'Inter');
  assert.equal(c.store.settings.value.fontSize, 23);
  assert.equal(c.store.synced.value, false);
});

test('reader flushes its latest pending position before leaving', async () => {
  const src = fs.readFileSync('app/pages/books/[id]/read.vue', 'utf8');
  const part = src.slice(
    src.indexOf('function scheduleSave('),
    src.indexOf('/** Navigate to the previous book page.'),
  );
  let leave;
  const saves = [];
  const c = {
    saveTimeout: null,
    pendingPosition: null,
    lastSavedLocation: null,
    saveQueue: Promise.resolve(),
    readerActive: true,
    setTimeout: () => 1,
    clearTimeout() {},
    saveReadingPosition: async (location, progress) => {
      saves.push({ location, progress });
    },
    onBeforeRouteLeave: (handler) => {
      leave = handler;
    },
  };
  vm.createContext(c);
  vm.runInContext(
    ts.transpile(part, { target: ts.ScriptTarget.ES2020 }) +
      ';globalThis.scheduleSave=scheduleSave;',
    c,
  );
  c.scheduleSave('first', 10);
  c.scheduleSave('latest', 20);
  await leave();
  assert.deepEqual(saves, [{ location: 'latest', progress: 20 }]);
});
