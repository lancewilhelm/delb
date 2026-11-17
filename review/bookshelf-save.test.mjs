import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { ref, toRaw } from 'vue';
import {
  BOOKSHELF_MAX_BOOKS,
  parseBookshelf,
  reconcileBookshelf,
} from '../shared/bookshelf.ts';

async function shelfEditor() {
  const raw = await readFile('app/components/Books/BookshelfView.vue', 'utf8');
  const source = raw.slice(raw.indexOf('>') + 1, raw.indexOf('</script>'));
  const ast = ts.createSourceFile(
    'shelf.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const wanted = [
    'save',
    'changed',
    'removeShelf',
    'removeBookcase',
    'moveBookcase',
    'moveBookcaseBy',
    'refreshCatalog',
    'resumePendingRefresh',
  ];
  const functions = ast.statements
    .filter(
      (item) =>
        ts.isFunctionDeclaration(item) &&
        wanted.includes(item.name?.text ?? ''),
    )
    .map((item) => item.getText(ast))
    .join('\n');
  const bookcase = (id) => ({
    id,
    width: 340,
    shelves: [
      { id: `${id}-first`, height: 245, items: [] },
      { id: `${id}-second`, height: 245, items: [] },
    ],
  });
  const arrangement = ref({
    bookcases: [bookcase('first'), bookcase('second')],
  });
  const payloads = [];
  let serverArrangement = structuredClone(toRaw(arrangement.value));
  let serverRevision = 1;
  let beforeSave = async () => {};
  let fetchCatalog = async () => [];
  const state = {
    arrangement,
    toRaw,
    parseBookshelf,
    reconcileBookshelf,
    BOOKSHELF_MAX_BOOKS,
    loading: ref(false),
    catalog: ref([]),
    adjustments: ref([]),
    fetchAll: () => fetchCatalog(),
    loadMatches: async () => {},
    errorText: (error) =>
      error instanceof Error ? error.message : 'Please try again.',
    saving: ref(false),
    dirty: ref(false),
    conflict: ref(false),
    saveError: ref(''),
    notice: ref(''),
    revision: ref(1),
    catalogToken: ref('token'),
    canEdit: ref(true),
    props: { collectionId: 'collection' },
    shelfPath: ref('/api/collections/collection/bookshelf'),
    shelfFrame: () => ({ floor: 0 }),
    zoom: ref(1),
    camera: { y: 0 },
    selectedShelf: ref(null),
    getBookcase: (id) =>
      arrangement.value.bookcases.find((item) =>
        item.shelves.some((shelf) => shelf.id === id),
      ),
    $fetch: async (_url, options) => {
      if (!options) {
        const books = await fetchCatalog();
        if (books.length > BOOKSHELF_MAX_BOOKS)
          throw new Error('Bookshelf supports up to 20,000 books.');
        return {
          revision: serverRevision,
          token: 'token',
          books,
          canEdit: true,
          adjustments: [],
          arrangement: reconcileBookshelf(serverArrangement, books).bookshelf,
        };
      }
      const parsed = parseBookshelf(options.body.arrangement);
      assert.ok(parsed, 'the saved arrangement must be valid');
      payloads.push(parsed);
      await beforeSave();
      serverArrangement = structuredClone(parsed);
      return { revision: ++serverRevision, token: 'token' };
    },
  };
  const js = ts.transpileModule(functions, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const actions = new Function(
    ...Object.keys(state),
    `let dirtyVersion = 0; let catalogGeneration = 0; let refreshPending = false; let disposed = false; ${js}; return {removeShelf, removeBookcase, moveBookcase, moveBookcaseBy, refreshCatalog};`,
  )(...Object.values(state));
  return {
    actions,
    state,
    payloads,
    setFetchCatalog: (fn) => {
      fetchCatalog = fn;
    },
    setBeforeSave: (fn) => {
      beforeSave = fn;
    },
  };
}

test('a refresh retries after edits made while its request is pending', async () => {
  const { actions, state, payloads, setFetchCatalog } = await shelfEditor();
  let resolveCatalog;
  let requests = 0;
  setFetchCatalog(() => {
    if (++requests > 1)
      return Promise.resolve([{ id: 'new-book', pages: 240 }]);
    return new Promise((resolve) => {
      resolveCatalog = resolve;
    });
  });
  const refresh = actions.refreshCatalog();
  actions.moveBookcase('first', null);
  await new Promise(setImmediate);
  resolveCatalog([{ id: 'new-book', pages: 240 }]);
  await refresh;
  await new Promise(setImmediate);
  const latest = payloads.at(-1);
  assert.deepEqual(
    latest.bookcases.map((entry) => entry.id),
    ['second', 'first'],
  );
  assert.equal(state.catalog.value[0].id, 'new-book');
  assert.deepEqual(
    state.arrangement.value.bookcases.map((entry) => entry.id),
    ['second', 'first'],
  );
  assert.ok(
    state.arrangement.value.bookcases
      .flatMap((entry) => entry.shelves)
      .flatMap((shelf) => shelf.items)
      .some((entry) => entry.books.some((book) => book.id === 'new-book')),
  );
  assert.equal(state.saveError.value, '');
});

test('a refresh requested during a save runs after the save and keeps the edit', async () => {
  const { actions, state, setFetchCatalog, setBeforeSave } =
    await shelfEditor();
  const pending = Promise.withResolvers();
  let reads = 0;
  setBeforeSave(() => pending.promise);
  setFetchCatalog(async () => {
    reads++;
    return [{ id: 'added' }];
  });
  actions.moveBookcase('first', null);
  await actions.refreshCatalog();
  assert.equal(reads, 0);
  pending.resolve();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  assert.deepEqual(
    state.arrangement.value.bookcases.map((entry) => entry.id),
    ['second', 'first'],
  );
  assert.equal(state.catalog.value[0].id, 'added');
  assert.equal(state.dirty.value, false);
});

test('an oversized catalog is reported without replacing or saving the current arrangement', async () => {
  const { actions, state, payloads, setFetchCatalog } = await shelfEditor();
  setFetchCatalog(async () =>
    Array(BOOKSHELF_MAX_BOOKS + 1).fill({ id: 'book' }),
  );
  await actions.refreshCatalog();
  assert.match(state.notice.value, /supports up to 20,000 books/);
  assert.deepEqual(
    state.arrangement.value.bookcases.map((entry) => entry.id),
    ['first', 'second'],
  );
  assert.equal(payloads.length, 0);
});

test('an older catalog response cannot overwrite a newer refresh', async () => {
  const { actions, state, setFetchCatalog } = await shelfEditor();
  const older = Promise.withResolvers();
  const newer = Promise.withResolvers();
  let count = 0;
  setFetchCatalog(() => (++count === 1 ? older.promise : newer.promise));
  const first = actions.refreshCatalog();
  const second = actions.refreshCatalog();
  newer.resolve([{ id: 'newer' }]);
  await second;
  older.resolve([{ id: 'older' }]);
  await first;
  assert.deepEqual(
    state.catalog.value.map((book) => book.id),
    ['newer'],
  );
  assert.deepEqual(
    state.arrangement.value.bookcases
      .flatMap((entry) => entry.shelves)
      .flatMap((shelf) => shelf.items)
      .flatMap((item) => item.books.map((book) => book.id)),
    ['newer'],
  );
});

test('reordering bookcases saves their order and remains editable', async () => {
  const { actions, state, payloads } = await shelfEditor();
  state.arrangement.value.bookcases[0].shelves[0].items.push({
    x: 2,
    horizontal: false,
    books: [
      {
        id: 'book',
        width: 32,
        height: 180,
        manualWidth: false,
        manualHeight: false,
        sourcePages: null,
      },
    ],
  });
  actions.moveBookcase('first', null);
  await new Promise(setImmediate);
  assert.deepEqual(
    payloads[0].bookcases.map((entry) => entry.id),
    ['second', 'first'],
  );
  assert.equal(
    payloads[0].bookcases[1].shelves[0].items[0].books[0].id,
    'book',
  );
  assert.equal(state.saveError.value, '');
  actions.moveBookcaseBy('first', -1);
  await new Promise(setImmediate);
  assert.deepEqual(
    payloads[1].bookcases.map((entry) => entry.id),
    ['first', 'second'],
  );
  actions.removeShelf(state.arrangement.value.bookcases[0].shelves[1]);
  await new Promise(setImmediate);
  assert.equal(state.saveError.value, '');
  assert.equal(payloads[2].bookcases[0].shelves.length, 1);
  assert.equal(
    payloads[2].bookcases[0].shelves[0].items[0].books[0].id,
    'book',
  );
  actions.moveBookcase('missing', null);
  actions.moveBookcaseBy('first', -1);
  assert.equal(payloads.length, 3);
});

for (const action of ['removeShelf', 'removeBookcase']) {
  test(`${action} saves the remaining arrangement`, async () => {
    const { actions, state, payloads } = await shelfEditor();
    actions[action](state.arrangement.value.bookcases[0].shelves[0]);
    await new Promise(setImmediate);
    assert.equal(state.saveError.value, '');
    assert.equal(state.dirty.value, false);
    assert.equal(payloads.length, 1);
    assert.equal(
      payloads[0].bookcases.length,
      action === 'removeBookcase' ? 1 : 2,
    );
    if (action === 'removeShelf')
      assert.equal(payloads[0].bookcases[0].shelves.length, 1);
  });
}
