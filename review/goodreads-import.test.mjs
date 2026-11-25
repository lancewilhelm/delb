import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileScript, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const goodreadsImport = await import('../app/utils/goodreadsImport.ts');
const responseError = await import('../app/utils/responseError.ts');

function compileComponent(path) {
  const { descriptor } = parse(
    readFileSync(new URL(path, import.meta.url), 'utf8'),
  );
  const compiled = compileScript(descriptor, {
    id: 'goodreads-import-test',
    inlineTemplate: true,
  });
  return transformSync(compiled.content, { loader: 'ts', format: 'cjs' }).code;
}
const code = compileComponent('../app/components/Settings/SettingsImport.vue');

function mount(fetch, collectionsStore) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name === 'vue') return vue;
      if (name === '~/utils/apiFetch') return { $fetch: fetch };
      if (name === '~/utils/goodreadsImport') return goodreadsImport;
      if (name === '~/utils/responseError') return responseError;
      if (name === '~/utils/dashboardCache')
        return { clearDashboardCache: () => undefined };
      if (name === '~/stores/collections')
        return { useCollectionsStore: () => collectionsStore };
      if (name === '~/components/Settings/UI/SettingsUIGroup.vue')
        return {
          __esModule: true,
          default: {
            setup:
              (_props, { slots }) =>
              () =>
                vue.h('div', slots.default?.()),
          },
        };
      throw new Error(`Unexpected require: ${name}`);
    },
    module,
    module.exports,
  );
  const node = (type, text = '') => ({
    type,
    text,
    value: '',
    props: {},
    children: [],
    parent: null,
    options: [],
    addEventListener() {},
    removeEventListener() {},
  });
  const renderer = vue.createRenderer({
    createElement: node,
    createText: (text) => node('#text', text),
    createComment: (text) => node('#comment', text),
    setText(el, text) {
      el.text = text;
    },
    setElementText(el, text) {
      el.text = text;
      el.children = [];
    },
    parentNode: (el) => el.parent,
    nextSibling: (el) => {
      const siblings = el.parent?.children ?? [];
      return siblings[siblings.indexOf(el) + 1] ?? null;
    },
    patchProp(el, key, _old, value) {
      el.props[key] = value;
      if (key === 'value') el.value = value;
    },
    insert(child, parent, anchor) {
      if (child.parent)
        child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(
        index < 0 ? parent.children.length : index,
        0,
        child,
      );
    },
    remove(child) {
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = null;
    },
  });
  const container = node('container');
  const app = renderer.createApp(module.exports.default);
  app.component('Icon', { render: () => null });
  app.component('RouterLink', {
    props: ['to'],
    setup:
      (props, { slots }) =>
      () =>
        vue.h('a', { href: props.to }, slots.default?.()),
  });
  app.mount(container);
  const all = (parent = container) => [
    parent,
    ...parent.children.flatMap((child) => all(child)),
  ];
  const textOf = (el) =>
    all(el)
      .map((n) => n.text)
      .join(' ')
      .replace(/\s+/g, ' ');
  const find = (predicate, label) => {
    const found = all().find(predicate);
    assert.ok(found, `Expected rendered ${label}`);
    return found;
  };
  const button = (label) =>
    find((el) => el.type === 'button' && textOf(el).includes(label), label);
  return { app, find, button, text: () => textOf(container) };
}

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(setImmediate);
    await vue.nextTick();
  }
};

const preview = {
  rows: [
    {
      index: 0,
      goodreadsId: '7235533',
      title: 'The Way of Kings',
      fullTitle: 'The Way of Kings (The Stormlight Archive, #1)',
      authors: ['Brandon Sanderson'],
      rating: 5,
      dateRead: '2023-05-14',
      exclusiveShelf: 'read',
      shelves: ['fantasy'],
      match: {
        kind: 'isbn',
        bookId: 'b1',
        candidates: [
          {
            bookId: 'b1',
            title: 'The Way of Kings',
            authors: ['Brandon Sanderson'],
            collectionName: 'Shared',
            hasFiles: true,
            score: 1,
          },
        ],
      },
    },
    {
      index: 1,
      goodreadsId: '2',
      title: 'Dune Messiah',
      fullTitle: 'Dune Messiah',
      authors: ['Frank Herbert'],
      rating: 0,
      exclusiveShelf: 'read',
      shelves: [],
      match: {
        kind: 'review',
        bookId: 'b2',
        candidates: [
          {
            bookId: 'b2',
            title: 'Dune: Messiah',
            authors: ['Frank Herbert'],
            collectionName: 'Shared',
            hasFiles: false,
            score: 0.88,
          },
        ],
      },
    },
    {
      index: 2,
      goodreadsId: '3',
      title: 'Project Hail Mary',
      fullTitle: 'Project Hail Mary',
      authors: ['Andy Weir'],
      rating: 0,
      exclusiveShelf: 'to-read',
      tbrPosition: 1,
      shelves: ['fantasy'],
      match: { kind: 'none', candidates: [] },
    },
  ],
  existing: {
    b1: {
      status: 'finished',
      endedDate: '2021-02-02',
      rating: 6,
      review: '',
      hasReview: false,
      tbrRank: null,
    },
  },
  exclusiveShelves: [
    { name: 'read', count: 2 },
    { name: 'to-read', count: 1 },
  ],
  shelves: [{ name: 'fantasy', count: 2 }],
};

test('the Goodreads import previews, resolves a difference, and imports into a new private collection', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, body: options.body });
    if (url === '/api/import/goodreads/preview') return { data: preview };
    if (url === '/api/collections')
      return { data: { collection: { id: 'c-new' } } };
    if (url === '/api/import/goodreads/books')
      return {
        data: {
          results: options.body.rows.map((r) => ({
            index: r.index,
            bookId: `new-${r.index}`,
          })),
        },
      };
    if (url === '/api/import/goodreads/apply')
      return {
        data: {
          reading: {
            statusesSet: 3,
            statusesKept: 0,
            ratingsSet: 1,
            ratingsKept: 0,
            reviewsSet: 0,
            reviewsKept: 0,
            notesAdded: 0,
            unavailable: [],
          },
          shelvesCreated: 1,
          shelvesUpdated: 0,
          shelfBooksAdded: 2,
          identifiersLinked: 2,
          errors: [],
        },
      };
    throw new Error(`Unexpected fetch ${url}`);
  };
  let refreshed = 0;
  const store = {
    collections: [{ id: 'c1', name: 'Shared', role: 'owner', isDefault: true }],
    activeCollection: null,
    canEditCollection: () => true,
    fetchCollections: async () => {
      refreshed++;
    },
  };
  const view = mount(fetch, store);
  await settle();

  view
    .find((el) => el.type === 'input' && el.props.type === 'file', 'file input')
    .props.onChange({ target: { files: [new File(['csv'], 'export.csv')] } });
  await settle();
  await view.button('Preview import').props.onClick();
  await settle();

  const text = view.text();
  assert.match(text, /3 books in the export/);
  assert.match(text, /Differences from Delb \(1\)/);
  assert.match(text, /Likely match — confirm/);
  assert.match(text, /Keep Delb: Finished 2021-02-02 · ★★★/);
  assert.match(text, /Use Goodreads: Finished 2023-05-14 · ★★★★★/);

  view
    .find(
      (el) =>
        el.type === 'input' &&
        el.props.name === 'conflict-0' &&
        el.props.checked === false,
      'Use Goodreads choice',
    )
    .props.onChange();
  view
    .find(
      (el) =>
        el.type === 'input' &&
        el.props.type === 'radio' &&
        el.props.value === 'new',
      'new collection choice',
    )
    .props['onUpdate:modelValue']('new');
  await settle();

  await view.button('Import').props.onClick();
  await settle();

  assert.match(view.text(), /Import finished\./);
  assert.equal(refreshed, 1);
  const urls = calls.map((c) => c.url);
  assert.deepEqual(urls, [
    '/api/import/goodreads/preview',
    '/api/collections',
    '/api/import/goodreads/books',
    '/api/import/goodreads/apply',
  ]);
  assert.deepEqual(calls[1].body, { name: 'Goodreads' });
  const create = calls[2].body;
  assert.equal(create.collectionId, 'c-new');
  assert.equal(create.enrich, false);
  assert.deepEqual(
    create.rows.map((r) => [r.index, 'match' in r]),
    [[2, false]],
  );
  const apply = calls[3].body;
  assert.deepEqual(
    apply.items.map((i) => [i.index, i.bookId, i.overwrite]),
    [
      [0, 'b1', true],
      [1, 'b2', false],
      [2, 'new-2', false],
    ],
  );
  assert.deepEqual(apply.statusMap, {
    read: 'finished',
    'to-read': 'to_be_read',
  });
  assert.deepEqual(apply.shelves, ['fantasy']);
  assert.equal(apply.include.reviews, true);
  view.app.unmount();
});
