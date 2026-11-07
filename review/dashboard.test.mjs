import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { createPinia, defineStore } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';
import * as vue from 'vue';

const { parse, compileScript } = createRequire(
  import.meta.resolve('nuxt/package.json'),
)('@vue/compiler-sfc');
const { renderToString } = createRequire(import.meta.resolve('vue'))(
  '@vue/server-renderer',
);

function evaluate(source, globals = {}) {
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    (name) => {
      if (name === 'vue') return vue;
      assert.equal(name, 'pinia');
      return { defineStore };
    },
    module,
    module.exports,
    ...Object.values(globals),
  );
  return module.exports;
}

function loadStore(name) {
  return evaluate(
    `import { ref, computed } from 'vue';\n${readFileSync(
      new URL(`../app/stores/${name}.ts`, import.meta.url),
      'utf8',
    )}`,
  );
}

const { useBooksIndexFiltersStore } = loadStore('booksIndexFilters');
const { useUiStore } = loadStore('ui');
const { useCollectionsStore } = loadStore('collections');

async function dashboard() {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const pinia = createPinia();
  pinia.use(createPersistedState({ storage }));
  const app = vue.createSSRApp({ render: () => vue.h(page) });
  app.use(pinia);
  const filters = useBooksIndexFiltersStore(pinia);
  const ui = useUiStore(pinia);
  const collections = useCollectionsStore(pinia);
  filters.$patch({
    addedStart: '2026-01-01',
    addedEnd: '2026-11-04',
    selectedStatuses: ['to_be_read'],
    includeNoStatus: true,
    filesFilter: 'none',
  });
  ui.setBooksSortKey('pages');
  ui.setBooksSortDirection('desc');
  ui.setBooksViewMode('list');
  collections.setActiveCollection('selected-collection');
  const initialFilters = JSON.stringify(filters.$state);
  const initialUi = JSON.stringify(ui.$state);
  const initialCollections = JSON.stringify(collections.$state);

  const { descriptor, errors } = parse(
    readFileSync(new URL('../app/pages/index.vue', import.meta.url), 'utf8'),
  );
  assert.deepEqual(errors, []);
  const compiled = compileScript(descriptor, {
    id: 'dashboard-test',
    inlineTemplate: true,
  });
  const { default: page } = evaluate(
    `import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';\n${compiled.content}`,
    {
      definePageMeta: () => undefined,
      useHead: () => undefined,
      useAuth: () => ({ user: vue.ref({ name: 'Reader' }) }),
      useRoute: () => ({ query: {} }),
      useRouter: () => ({ replace: () => undefined }),
      useCollectionsStore: () => collections,
      useBooksIndexFiltersStore: () => filters,
    },
  );
  const links = [];
  app.component('NuxtLink', {
    props: ['to'],
    setup(props, { attrs, slots }) {
      links.push({ to: props.to, onClick: attrs.onClick });
      return () => vue.h('a', { href: props.to }, slots.default?.());
    },
  });
  for (const name of [
    'AppHeader',
    'ViewSelectorDropdown',
    'Icon',
    'BookThumbnail',
  ]) {
    app.component(name, { render: () => null });
  }
  await renderToString(app);
  return {
    filters,
    ui,
    collections,
    initialFilters,
    initialUi,
    initialCollections,
    links,
    storage,
  };
}

test('dashboard All books clears every persisted filter and preserves browsing preferences', async () => {
  const view = await dashboard();
  assert.equal(JSON.stringify(view.filters.$state), view.initialFilters);
  const allBooks = view.links.find((link) => link.to === '/books');
  assert.ok(allBooks, 'the dashboard links to All books');
  await allBooks.onClick?.();

  assert.equal(
    view.filters.isApplied,
    false,
    'All books clears active filters',
  );
  assert.equal(view.filters.addedStart, '');
  assert.equal(view.filters.addedEnd, '');
  assert.deepEqual(view.filters.selectedStatuses, []);
  assert.equal(view.filters.includeNoStatus, false);
  assert.equal(view.filters.filesFilter, 'any');
  assert.deepEqual(view.filters.statusQuery, {});
  assert.deepEqual(view.filters.addedDateQuery, {});
  assert.deepEqual(view.filters.filesQuery, {});
  assert.equal(JSON.stringify(view.ui.$state), view.initialUi);
  assert.equal(
    JSON.stringify(view.collections.$state),
    view.initialCollections,
  );

  view.filters.$persist();
  const pinia = createPinia();
  pinia.use(createPersistedState({ storage: view.storage }));
  vue.createSSRApp({ render: () => null }).use(pinia);
  assert.equal(
    useBooksIndexFiltersStore(pinia).isApplied,
    false,
    'cleared filters remain persisted',
  );
});

function mountedComponent(filename, globals, rootProps = {}) {
  const node = (tag, text = '') => ({
    tag,
    text,
    children: [],
    props: {},
    parent: null,
  });
  const renderer = vue.createRenderer({
    createElement: node,
    createText: (text) => node('#text', text),
    createComment: (text) => node('#comment', text),
    setText: (element, text) => {
      element.text = text;
    },
    setElementText: (element, text) => {
      element.text = text;
      element.children = [];
    },
    parentNode: (element) => element.parent,
    nextSibling: (element) =>
      element.parent?.children[element.parent.children.indexOf(element) + 1] ??
      null,
    patchProp: (element, key, _previous, value) => {
      element.props[key] = value;
    },
    insert(element, parent, anchor) {
      if (element.parent)
        element.parent.children.splice(
          element.parent.children.indexOf(element),
          1,
        );
      const index = anchor
        ? parent.children.indexOf(anchor)
        : parent.children.length;
      parent.children.splice(index, 0, element);
      element.parent = parent;
    },
    remove(element) {
      element.parent?.children.splice(
        element.parent.children.indexOf(element),
        1,
      );
      element.parent = null;
    },
  });
  const { descriptor } = parse(
    readFileSync(new URL(filename, import.meta.url), 'utf8'),
  );
  const compiled = compileScript(descriptor, {
    id: 'interaction-test',
    inlineTemplate: true,
  });
  const { default: component } = evaluate(
    `import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';\n${compiled.content}`,
    globals,
  );
  const app = renderer.createApp({ render: () => vue.h(component, rootProps) });
  app.directive('tooltip', {});
  for (const name of ['AppHeader', 'ViewSelectorDropdown', 'Icon'])
    app.component(name, { render: () => null });
  app.component('BookThumbnail', {
    props: ['book'],
    render() {
      return vue.h(
        'span',
        { 'data-status': this.book.status },
        this.book.title,
      );
    },
  });
  app.component('NuxtLink', {
    props: ['to'],
    setup:
      (props, { attrs, slots }) =>
      () =>
        vue.h('a', { ...attrs, href: props.to }, slots.default?.()),
  });
  const root = node('root');
  app.mount(root);
  const all = (element = root) => [element, ...element.children.flatMap(all)];
  const text = () =>
    all()
      .map((element) => element.text)
      .join(' ');
  const button = (label) =>
    all().find(
      (element) => element.tag === 'button' && element.text.trim() === label,
    );
  return { app, all, text, button };
}

async function flush() {
  for (let index = 0; index < 4; index++) await vue.nextTick();
}

test('shelf changes reject stale scope responses and loading more can retry without losing books', async (t) => {
  const route = vue.reactive({ query: {} });
  const collections = vue.reactive({
    collections: [{}],
    activeSelection: { kind: 'all' },
    activeCollection: null,
  });
  const requests = [];
  const view = mountedComponent('../app/pages/index.vue', {
    definePageMeta() {},
    useHead() {},
    useAuth: () => ({ user: vue.ref({ name: 'Reader' }) }),
    useCollectionsStore: () => collections,
    useBooksIndexFiltersStore: () => ({ clearAll() {} }),
    useRoute: () => route,
    useRouter: () => ({
      replace: ({ query }) => {
        route.query = query;
      },
    }),
    $fetch: (_url, options) =>
      new Promise((resolve, reject) =>
        requests.push({ ...options, resolve, reject }),
      ),
  });
  t.after(() => view.app.unmount());
  const result = (title, kind, nextOffset = null) => ({
    success: true,
    data: {
      counts: {
        total: 20,
        reading: 1,
        finished: 19,
        none: 0,
        to_be_read: 0,
        dnf: 0,
      },
      shelf: {
        kind,
        nextOffset,
        books: [
          {
            id: title,
            title,
            updatedAt: '2026-01-01',
            progress: 10,
            finishedDate: null,
          },
        ],
      },
    },
  });
  assert.equal(requests.length, 1);
  assert.ok(view.text().includes('Loading…'));
  view.button('Recently finished').props.onClick();
  await flush();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].query.shelf, 'finished');
  collections.activeSelection = {
    kind: 'collection',
    collectionId: 'new-scope',
  };
  await flush();
  assert.equal(requests[2].query.collectionId, 'new-scope');
  requests[1].resolve(result('Old scope finished book', 'finished'));
  await flush();
  assert.ok(!view.text().includes('Old scope finished book'));
  requests[2].resolve(result('New scope finished book', 'finished', 12));
  await flush();
  assert.ok(view.text().includes('New scope finished book'));
  view.button('Show more').props.onClick();
  await flush();
  assert.equal(requests[3].query.offset, 12);
  requests[3].reject(new Error('offline'));
  await flush();
  assert.ok(view.text().includes('New scope finished book'));
  assert.ok(view.text().includes('Could not load this shelf'));
  view.button('Retry').props.onClick();
  await flush();
  assert.equal(requests[4].query.offset, 12);
  requests[4].resolve(result('Next page finished book', 'finished'));
  await flush();
  assert.ok(
    view.text().includes('New scope finished book') &&
      view.text().includes('Next page finished book'),
  );
  assert.equal(view.button('Show more'), undefined);
  view
    .all()
    .find(
      (element) =>
        element.tag === 'span' && element.text === 'New scope finished book',
    )
    .props.onStatusChange({
      bookId: 'New scope finished book',
      status: 'reading',
    });
  await flush();
  assert.equal(
    requests.length,
    5,
    'status changes retain the loaded shelf without a new request',
  );
  assert.ok(view.text().includes('Next page finished book'));
  assert.ok(!view.text().includes('New scope finished book'));
  const countValues = view
    .all()
    .filter((element) => element.props.class === 'dashboard-count-value')
    .map((element) => element.text);
  assert.equal(countValues[1], '2');
  assert.equal(countValues[3], '18');
  requests[0].resolve(result('Stale initial reading', 'reading'));
  await flush();
  assert.ok(!view.text().includes('Stale initial reading'));
  view.button('To be read').props.onClick();
  await flush();
  assert.equal(requests[5].query.shelf, 'tbr');
  requests[5].resolve(result('Queued book', 'tbr'));
  await flush();
  const queuedBook = view
    .all()
    .find(
      (element) => element.tag === 'span' && element.text === 'Queued book',
    );
  assert.equal(queuedBook.props['data-status'], 'to_be_read');
});

test('status changes preserve shelf contents and adjust a pending page without skipping books', async (t) => {
  for (const shelf of ['reading', 'finished', 'tbr']) {
    const status = shelf === 'tbr' ? 'to_be_read' : shelf;
    const requests = [];
    const view = mountedComponent('../app/pages/index.vue', {
      definePageMeta() {},
      useHead() {},
      useAuth: () => ({ user: vue.ref({ name: 'Reader' }) }),
      useCollectionsStore: () => ({
        collections: [{}],
        activeSelection: { kind: 'all' },
      }),
      useBooksIndexFiltersStore: () => ({ clearAll() {} }),
      useRoute: () => ({ query: { shelf } }),
      useRouter: () => ({ replace() {} }),
      $fetch: (_url, options) =>
        new Promise((resolve) => requests.push({ ...options, resolve })),
    });
    t.after(() => view.app.unmount());
    const counts = {
      total: 20,
      none: 0,
      to_be_read: 0,
      reading: 0,
      finished: 0,
      dnf: 0,
      [status]: 20,
    };
    const response = (ids, nextOffset, saved = false) => ({
      success: true,
      data: {
        counts: saved ? { ...counts, [status]: 19, none: 1 } : counts,
        shelf: {
          kind: shelf,
          nextOffset,
          books: ids.map((id) => ({
            id,
            title: id,
            updatedAt: '2026-11-04',
            progress: 10,
            finishedDate: shelf === 'finished' ? '2026-11-04' : null,
          })),
        },
      },
    });
    assert.equal(requests[0].query.shelf, shelf);
    if (shelf === 'tbr') {
      assert.ok(
        view
          .all()
          .some(
            (element) =>
              element.tag === 'a' &&
              element.props.href === '/to-be-read' &&
              element.props.class === 'dashboard-view-all',
          ),
      );
    }
    requests[0].resolve(
      response(
        Array.from({ length: 12 }, (_, i) => `book-${i}`),
        12,
      ),
    );
    await flush();
    const firstBook = view
      .all()
      .find((element) => element.tag === 'span' && element.text === 'book-0');
    assert.equal(
      firstBook.props['data-status'],
      status,
      'shelf status reaches cover badges',
    );
    firstBook.props.onStatusChange({ bookId: 'book-0', status });
    await flush();
    assert.equal(
      requests.length,
      1,
      'keeping the current status does not reload the shelf',
    );
    view.button('Show more').props.onClick();
    await flush();
    assert.equal(requests[1].query.offset, 12);
    firstBook.props.onStatusChange({ bookId: 'book-0', status: null });
    await flush();
    assert.equal(
      requests[1].signal.aborted,
      true,
      'pending page used the old offset',
    );
    assert.equal(
      requests[2].query.offset,
      11,
      'removed row is subtracted from the next offset',
    );
    assert.ok(!view.text().includes('book-0'));
    assert.ok(
      view.text().includes('book-11'),
      'other loaded books remain visible',
    );
    requests[1].resolve(response(['stale-page'], null));
    await flush();
    assert.ok(!view.text().includes('stale-page'));
    requests[2].resolve(
      response(
        Array.from({ length: 8 }, (_, i) => `book-${i + 12}`),
        null,
        true,
      ),
    );
    await flush();
    assert.equal(
      view.all().filter((element) => element.props['data-status'] === status)
        .length,
      19,
    );
    assert.equal(view.button('Show more'), undefined);
    const countValues = view
      .all()
      .filter((element) => element.props.class === 'dashboard-count-value')
      .map((element) => element.text);
    assert.equal(
      countValues[status === 'reading' ? 1 : status === 'to_be_read' ? 2 : 3],
      '19',
    );
    assert.equal(countValues[5], '1');
    view.app.unmount();
  }
});

test('Recently read preserves calendar dates across browser timezones', async (t) => {
  const previousTimezone = process.env.TZ;
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });
  for (const timezone of ['America/New_York', 'Pacific/Kiritimati']) {
    process.env.TZ = timezone;
    const view = mountedComponent('../app/pages/index.vue', {
      definePageMeta() {},
      useHead() {},
      useAuth: () => ({ user: vue.ref({ name: 'Reader' }) }),
      useCollectionsStore: () => ({
        collections: [{}],
        activeSelection: { kind: 'all' },
      }),
      useBooksIndexFiltersStore: () => ({ clearAll() {} }),
      useRoute: () => ({ query: { shelf: 'finished' } }),
      useRouter: () => ({ replace() {} }),
      $fetch: async () => ({
        success: true,
        data: {
          counts: {
            total: 1,
            reading: 0,
            finished: 1,
            none: 0,
            to_be_read: 0,
            dnf: 0,
          },
          shelf: {
            kind: 'finished',
            nextOffset: null,
            books: [
              {
                id: 'date',
                title: 'Date test',
                updatedAt: '2026-11-02',
                finishedDate: '2026-11-02',
                progress: null,
              },
            ],
          },
        },
      }),
    });
    t.after(() => view.app.unmount());
    await flush();
    assert.match(view.text(), /Read Nov 2, 2026/);
    view.app.unmount();
  }
});

test('dashboard status links preserve filters and TBR opens its dedicated queue', async () => {
  const view = await dashboard();
  const statusLinks = view.links.filter((link) => link.to !== '/books');
  assert.deepEqual(
    statusLinks.map((link) => link.to),
    [
      '/books?status=reading',
      '/to-be-read',
      '/books?status=finished',
      '/books?status=dnf',
      '/books?status=none',
      '/books?status=reading',
    ],
  );
  for (const link of statusLinks) await link.onClick?.();
  assert.equal(JSON.stringify(view.filters.$state), view.initialFilters);
});
