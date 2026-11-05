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
    'BookFavoriteButton',
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
      return vue.h('span', this.book.title);
    },
  });
  app.component('BookFavoriteButton', { render: () => null });
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
            finishedAt: null,
            userFavorite: false,
          },
        ],
      },
    },
  });
  assert.equal(requests.length, 1);
  assert.ok(view.text().includes('Loading…'));
  view.button('Favorites').props.onClick();
  await flush();
  assert.equal(requests[0].signal.aborted, true);
  collections.activeSelection = {
    kind: 'collection',
    collectionId: 'new-scope',
  };
  await flush();
  assert.equal(requests[2].query.collectionId, 'new-scope');
  requests[1].resolve(result('Old scope favorite', 'favorites'));
  await flush();
  assert.ok(!view.text().includes('Old scope favorite'));
  requests[2].resolve(result('New scope favorite', 'favorites', 12));
  await flush();
  assert.ok(view.text().includes('New scope favorite'));
  view.button('Show more').props.onClick();
  await flush();
  assert.equal(requests[3].query.offset, 12);
  requests[3].reject(new Error('offline'));
  await flush();
  assert.ok(view.text().includes('New scope favorite'));
  assert.ok(view.text().includes('Could not load this shelf'));
  view.button('Retry').props.onClick();
  await flush();
  assert.equal(requests[4].query.offset, 12);
  requests[4].resolve(result('Next page favorite', 'favorites'));
  await flush();
  assert.ok(
    view.text().includes('New scope favorite') &&
      view.text().includes('Next page favorite'),
  );
  assert.equal(view.button('Show more'), undefined);
  requests[0].resolve(result('Stale initial reading', 'reading'));
  await flush();
  assert.ok(!view.text().includes('Stale initial reading'));
});

test('favorite controls wait for acknowledgement and retain the saved value when a request fails', async (t) => {
  const requests = [];
  const props = vue.reactive({
    bookId: 'one',
    title: 'One',
    favorite: false,
    onUpdated: (favorite) => {
      props.favorite = favorite;
    },
  });
  const view = mountedComponent(
    '../app/components/BookFavoriteButton.vue',
    {
      $fetch: (_url, options) =>
        new Promise((resolve, reject) =>
          requests.push({ ...options, resolve, reject }),
        ),
    },
    props,
  );
  t.after(() => view.app.unmount());
  const button = () => view.all().find((element) => element.tag === 'button');
  button().props.onClick({ stopPropagation() {} });
  await flush();
  assert.equal(button().props.disabled, true);
  assert.equal(button().props['aria-pressed'], false);
  requests[0].resolve({ success: true, data: { userFavorite: true } });
  await flush();
  assert.equal(button().props['aria-pressed'], true);
  button().props.onClick({ stopPropagation() {} });
  await flush();
  assert.deepEqual(requests[1].body, { favorite: false });
  requests[1].reject(new Error('offline'));
  await flush();
  assert.equal(button().props['aria-pressed'], true);
  assert.equal(button().props.disabled, false);
  assert.ok(view.text().includes('Could not save favorite'));
  button().props.onClick({ stopPropagation() {} });
  await flush();
  requests[2].resolve({ success: true, data: { userFavorite: false } });
  await flush();
  assert.equal(button().props['aria-pressed'], false);
  assert.ok(!view.text().includes('Could not save favorite'));
});

test('Recently read shows the local calendar date in timezones ahead of UTC', async (t) => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati';
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });
  const view = mountedComponent('../app/pages/index.vue', {
    definePageMeta() {},
    useHead() {},
    useAuth: () => ({ user: vue.ref({ name: 'Reader' }) }),
    useCollectionsStore: () => ({
      collections: [{}],
      activeSelection: { kind: 'all' },
    }),
    useBooksIndexFiltersStore: () => ({ clearAll() {} }),
    useRoute: () => ({ query: { shelf: 'recent' } }),
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
          kind: 'recent',
          nextOffset: null,
          books: [
            {
              id: 'date',
              title: 'Date test',
              updatedAt: '2026-11-02',
              finishedAt: '2026-11-01T10:00:00.000Z',
              progress: null,
              userFavorite: false,
            },
          ],
        },
      },
    }),
  });
  t.after(() => view.app.unmount());
  await flush();
  assert.match(view.text(), /Read Nov 2, 2026/);
});

test('other dashboard status links keep their targets and do not clear filters', async () => {
  const view = await dashboard();
  const statusLinks = view.links.filter((link) => link.to !== '/books');
  assert.deepEqual(
    statusLinks.map((link) => link.to),
    ['reading', 'to_be_read', 'finished', 'dnf', 'none', 'reading'].map(
      (status) => `/books?status=${status}`,
    ),
  );
  for (const link of statusLinks) await link.onClick?.();
  assert.equal(JSON.stringify(view.filters.$state), view.initialFilters);
});
