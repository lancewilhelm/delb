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
    `import { ref, computed, watch, onMounted } from 'vue';\n${compiled.content}`,
    {
      definePageMeta: () => undefined,
      useHead: () => undefined,
      useAuth: () => ({ user: vue.ref({ name: 'Reader' }) }),
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
