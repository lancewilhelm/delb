import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileScript, parse } from '@vue/compiler-sfc';
import { renderToString } from '@vue/server-renderer';
import { transformSync } from 'esbuild';
import { createPinia, defineStore } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';
import * as vue from 'vue';

const StubNull = { render: () => null };
const libraryCards = [];
const LibraryStub = {
  props: ['libraryArt', 'showStatusBar'],
  emits: ['set-art'],
  setup(props, { emit }) {
    libraryCards.push({ props, setArt: (style) => emit('set-art', style) });
    return () => null;
  },
};
const continueCards = [];
const ContinueStub = {
  props: ['book'],
  emits: ['status-change'],
  setup(props, { emit }) {
    continueCards.push({
      props,
      change: (status) =>
        emit('status-change', { bookId: props.book.id, status }),
    });
    return () =>
      vue.h('span', `${props.book.title} ${props.book.progress?.toFixed(1)}%`);
  },
};

function evaluate(source, globals = {}, linkCapture = null) {
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  const RouterLink = {
    props: ['to'],
    setup(props, { attrs, slots }) {
      if (linkCapture)
        linkCapture.push({ to: props.to, onClick: attrs.onClick });
      return () => vue.h('a', { ...attrs, href: props.to }, slots.default?.());
    },
  };
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    (name) => {
      if (name === 'vue') return vue;
      if (name === '@vueuse/core')
        return { useElementSize: () => ({ width: vue.ref(0) }) };
      if (name === 'pinia') return { defineStore };
      if (name === 'vue-router') return { RouterLink };
      if (name === '~/utils/apiFetch')
        return { $fetch: globals.$fetch ?? (async () => ({})) };
      if (name === '~/utils/bookPreviewCache')
        return { primeBookPreviews: () => undefined };
      if (name === '~/utils/dashboardCache')
        return {
          readDashboardCache: () => null,
          writeDashboardCache: () => undefined,
          readShelvesCache: () => null,
          writeShelvesCache: () => undefined,
        };
      if (name === '~/utils/dashboardArt') return dashboardArt;
      if (name === '~/composables/useAuth') return { useAuth: globals.useAuth };
      if (name === '~/composables/useHead')
        return { useHead: globals.useHead ?? (() => undefined) };
      if (name === '~/stores/collections')
        return { useCollectionsStore: globals.useCollectionsStore };
      if (name === '~/stores/booksIndexFilters')
        return { useBooksIndexFiltersStore: globals.useBooksIndexFiltersStore };
      if (name === '~/stores/ui')
        return { useUiStore: globals.useUiStore ?? (() => ({})) };
      if (name === '~/stores/userSettings')
        return { useUserSettingsStore: globals.useUserSettingsStore };
      if (name === '~/components/Dashboard/DashboardContinueCard.vue')
        return { __esModule: true, default: ContinueStub };
      if (name === '~/components/Dashboard/DashboardLibraryCard.vue')
        return { __esModule: true, default: LibraryStub };
      if (name === '~/components/Dashboard/DashboardListTile.vue')
        return { __esModule: true, default: globals.TileStub ?? StubNull };
      if (name.startsWith('~/components/'))
        return { __esModule: true, default: StubNull };
      throw new Error(`Unexpected require in dashboard.test.mjs: ${name}`);
    },
    module,
    module.exports,
    ...Object.values(globals),
  );
  return module.exports;
}

const dashboardArt = evaluate(
  readFileSync(
    new URL('../app/utils/dashboardArt.ts', import.meta.url),
    'utf8',
  ),
);

function loadStore(name) {
  return evaluate(
    readFileSync(new URL(`../app/stores/${name}.ts`, import.meta.url), 'utf8'),
  );
}

function compile(filename, globals, links) {
  const { descriptor, errors } = parse(
    readFileSync(new URL(filename, import.meta.url), 'utf8'),
  );
  assert.deepEqual(errors, []);
  const compiled = compileScript(descriptor, {
    id: 'dashboard-test',
    inlineTemplate: true,
  });
  return evaluate(compiled.content, globals, links).default;
}

const { useBooksIndexFiltersStore } = loadStore('booksIndexFilters');
const { useUiStore } = loadStore('ui');
const { useCollectionsStore } = loadStore('collections');

const counts = {
  total: 20,
  reading: 2,
  to_be_read: 5,
  finished: 10,
  dnf: 0,
  none: 3,
};
const book = (id, extra = {}) => ({
  id,
  title: id,
  coverImagePath: null,
  hasPhysicalCopy: false,
  hasAudiobookCopy: false,
  updatedAt: '2026-11-01T00:00:00Z',
  progress: null,
  finishedDate: null,
  ...extra,
});

/** Server-renders the All books card with persisted browsing state. */
async function libraryCard() {
  const links = [];
  let card = null;
  const cardProps = {
    counts,
    recent: Array.from({ length: 20 }, (_, i) => book(`recent-${i}`)),
    showStatusBar: true,
  };
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const pinia = createPinia();
  pinia.use(createPersistedState({ storage }));
  // Pinia plugins (persistence) only attach once pinia is installed on an app.
  const app = vue.createSSRApp({ render: () => vue.h(card, cardProps) });
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

  card = compile(
    '../app/components/Dashboard/DashboardLibraryCard.vue',
    {
      useBooksIndexFiltersStore: () => filters,
      useUiStore: () => ui,
    },
    links,
  );
  app.component('Icon', StubNull);
  const html = await renderToString(app);
  return {
    html,
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

test('All books clears every persisted filter and preserves browsing preferences', async () => {
  const view = await libraryCard();
  const allBooks = view.links.find((link) => link.to === '/books');
  assert.ok(allBooks, 'the All books card links to the Books view');
  await allBooks.onClick?.();

  assert.equal(view.filters.isApplied, false, 'All books clears filters');
  assert.equal(view.filters.addedStart, '');
  assert.equal(view.filters.addedEnd, '');
  assert.deepEqual(view.filters.selectedStatuses, []);
  assert.equal(view.filters.includeNoStatus, false);
  assert.equal(view.filters.filesFilter, 'any');
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

test('status chips preserve filters and link only non-empty statuses', async () => {
  const view = await libraryCard();
  const statusLinks = view.links.filter((link) => link.to !== '/books');
  assert.deepEqual(
    statusLinks.map((link) => link.to),
    [
      '/books?status=reading',
      '/books?status=to_be_read',
      '/books?status=finished',
      '/books?status=none',
    ],
  );
  for (const link of statusLinks) await link.onClick?.();
  assert.equal(JSON.stringify(view.filters.$state), view.initialFilters);
  assert.match(view.html, /aria-label="Reading status: Reading 10%/);
});

// ---- Page behavior (custom renderer, no DOM) --------------------------------
function mountedPage(globals) {
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
  const page = compile('../app/pages/index.vue', globals);
  const app = renderer.createApp({ render: () => vue.h(page) });
  app.component('Icon', StubNull);
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

function settingsStore() {
  const store = vue.reactive({
    activeSettings: { dashboard: dashboardArt.defaultDashboardSettings() },
    patches: [],
    updateSettingAtPath(path, value) {
      assert.equal(path, 'dashboard.libraryArt');
      store.activeSettings.dashboard = dashboardArt.normalizeDashboardSettings({
        ...structuredClone(vue.toRaw(store.activeSettings.dashboard)),
        libraryArt: value,
      });
    },
    updateSettings(patch) {
      store.patches.push(patch);
      const next = structuredClone(vue.toRaw(store.activeSettings.dashboard));
      Object.assign(next.cardArt.overrides, patch.dashboard.cardArt.overrides);
      store.activeSettings.dashboard =
        dashboardArt.normalizeDashboardSettings(next);
    },
  });
  return store;
}

function harness(
  t,
  collections = { collections: [{}], activeSelection: { kind: 'all' } },
) {
  const requests = [];
  const tiles = [];
  const TileStub = {
    props: ['listKey', 'artStyle', 'books', 'to', 'count', 'overridden'],
    emits: ['set-art'],
    setup(props, { emit }) {
      tiles.push({ props, setArt: (style) => emit('set-art', style) });
      return () => vue.h('span', { 'data-tile': props.listKey });
    },
  };
  const settings = settingsStore();
  const view = mountedPage({
    useHead() {},
    useAuth: () => ({ user: vue.ref({ id: 'u1', name: 'Reader' }) }),
    useCollectionsStore: () => collections,
    useUserSettingsStore: () => settings,
    TileStub,
    $fetch: (url, options) =>
      new Promise((resolve, reject) =>
        requests.push({ url, ...options, resolve, reject }),
      ),
  });
  t.after(() => view.app.unmount());
  return { view, requests, tiles, settings };
}

const overview = (title) => ({
  success: true,
  data: {
    counts,
    recent: [book(title)],
    lists: {
      reading: [book(title, { progress: 42 })],
      to_be_read: [book('Queued')],
      finished: [book('Done', { finishedDate: '2026-11-02' })],
      dnf: [],
      none: [],
    },
  },
});

test('collection changes ignore stale overview responses and errors can retry', async (t) => {
  const collections = vue.reactive({
    collections: [{}],
    activeSelection: { kind: 'all' },
    activeCollection: null,
  });
  const { view, requests } = harness(t, collections);
  const overviews = () =>
    requests.filter((r) => r.url === '/api/dashboard/overview');
  const shelves = requests.find((r) => r.url === '/api/shelves');
  assert.equal(shelves.query.previews, 25, 'shelves ask for card-art previews');
  assert.equal(overviews().length, 1);
  assert.ok(view.text().includes('Loading…'));

  collections.activeSelection = { kind: 'collection', collectionId: 'scope-b' };
  await flush();
  assert.equal(overviews()[0].signal.aborted, true);
  assert.equal(overviews()[1].query.collectionId, 'scope-b');

  overviews()[0].resolve(overview('Old scope book'));
  await flush();
  assert.ok(!view.text().includes('Old scope book'));

  overviews()[1].reject(new Error('offline'));
  await flush();
  assert.ok(view.text().includes('Could not load your dashboard'));
  view.button('Retry').props.onClick();
  await flush();
  assert.equal(overviews()[2].query.collectionId, 'scope-b');
  overviews()[2].resolve(overview('New scope book'));
  await flush();
  assert.ok(view.text().includes('New scope book'), 'Continue reading shows');
  assert.ok(view.text().includes('42.0%'));
  assert.ok(!view.text().includes('Could not load your dashboard'));

  // Re-saving Reading keeps the overview; moving a book out reloads it.
  const card = continueCards.findLast(
    (c) => c.props.book.id === 'New scope book',
  );
  card.change('reading');
  await flush();
  assert.equal(overviews().length, 3);
  card.change('finished');
  await flush();
  assert.equal(overviews().length, 4, 'status change reloads the overview');
  assert.equal(overviews()[3].query.collectionId, 'scope-b');
});

test('status tiles use Auto art, link to their lists, and save per-tile choices', async (t) => {
  const { requests, tiles, settings } = harness(t);
  requests
    .find((r) => r.url === '/api/dashboard/overview')
    .resolve(overview('Book'));
  requests
    .find((r) => r.url === '/api/shelves')
    .resolve({
      data: {
        shelves: [
          {
            id: 's1',
            name: 'Favs',
            count: 2,
            previews: [{ id: 'a', title: 'A' }],
          },
        ],
      },
    });
  await flush();
  const tile = (key) => tiles.findLast((entry) => entry.props.listKey === key);
  assert.deepEqual(
    ['reading', 'to_be_read', 'finished', 'dnf', 'none', 'shelf:s1'].map(
      (key) => tile(key).props.artStyle,
    ),
    ['stack', 'fan', 'shelf', 'stack', 'pile', 'fan'],
  );
  assert.equal(tile('to_be_read').props.to, '/to-be-read');
  assert.equal(tile('finished').props.to, '/books?status=finished');
  assert.equal(tile('shelf:s1').props.to, '/shelves/s1');

  tile('to_be_read').setArt('wall');
  await flush();
  assert.equal(tile('to_be_read').props.artStyle, 'wall');
  assert.equal(tile('to_be_read').props.overridden, true);
  tile('to_be_read').setArt(null);
  await flush();
  assert.equal(tile('to_be_read').props.artStyle, 'fan', 'reset to Auto');
  assert.deepEqual(settings.activeSettings.dashboard.cardArt.overrides, {});
});

test('the All books card switches between Wall and Pile through settings', async (t) => {
  const { settings } = harness(t);
  await flush();
  const card = libraryCards.at(-1);
  assert.equal(card.props.libraryArt, 'wall', 'Wall is the default');
  assert.equal(card.props.showStatusBar, true);
  card.setArt('pile');
  await flush();
  assert.equal(settings.activeSettings.dashboard.libraryArt, 'pile');
  assert.equal(card.props.libraryArt, 'pile');
});
