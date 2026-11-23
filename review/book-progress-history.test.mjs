import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileScript, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
const { descriptor } = parse(
  readFileSync(
    new URL('../app/components/Books/BookProgressHistory.vue', import.meta.url),
    'utf8',
  ),
);
const compiled = compileScript(descriptor, {
  id: 'progress-test',
  inlineTemplate: true,
});
const code = transformSync(compiled.content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const StubLink = {
  props: ['to'],
  setup:
    (props, { slots }) =>
    () =>
      vue.h('a', { href: props.to }, slots.default?.()),
};
const StubNull = { render: () => null };
const StubTbrEditor = {
  props: ['bookId', 'rationale'],
  setup: (props) => () =>
    vue.h('div', {
      'data-editor-book': props.bookId,
      'data-editor-value': props.rationale,
    }),
};
function mount(fetch, props, { compiledCode = code, globals = {} } = {}) {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    '$fetch',
    ...Object.keys(globals),
    compiledCode,
  )(
    (name) => {
      if (name === 'vue') return vue;
      if (name === 'vue-router') return { RouterLink: StubLink };
      if (name === '~/utils/apiFetch') return { $fetch: fetch };
      if (name === '~/utils/descriptionHtml')
        return { sanitizeDescriptionHtml: (value) => value };
      if (name === '~/composables/useHead')
        return { useHead: globals.useHead ?? (() => undefined) };
      if (name === '~/stores/ui') return { useUiStore: globals.useUiStore };
      if (name === '~/components/Books/TbrRationaleEditor.vue')
        return { __esModule: true, default: StubTbrEditor };
      if (name.startsWith('~/components/'))
        return { __esModule: true, default: StubNull };
      throw new Error(`Unexpected require: ${name}`);
    },
    module,
    module.exports,
    fetch,
    ...Object.values(globals),
  );
  const node = (type, text = '') => ({
    type,
    tagName: type.toUpperCase(),
    text,
    value: '',
    props: {},
    children: [],
    parent: null,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    getRootNode() {
      return globalThis.document;
    },
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
    parentNode: (el) => el?.parent ?? null,
    nextSibling: (el) => {
      if (!el?.parent) return null;
      return el.parent.children[el.parent.children.indexOf(el) + 1] ?? null;
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
  const app = renderer.createApp(module.exports.default, props);
  app.component('Icon', { render: () => null });
  app.component('NuxtLink', {
    props: ['to'],
    setup:
      (props, { slots }) =>
      () =>
        vue.h('a', { href: props.to }, slots.default?.()),
  });
  for (const name of [
    'AppHeader',
    'ViewSelectorDropdown',
    'BookCover',
    'ClientOnly',
  ])
    app.component(name, { render: () => null });
  app.component('BooksTbrRationaleEditor', {
    props: ['bookId', 'rationale'],
    setup: (props) => () =>
      vue.h('div', {
        'data-editor-book': props.bookId,
        'data-editor-value': props.rationale,
      }),
  });
  app.mount(container);
  const all = (parent = container) => [
    parent,
    ...parent.children.flatMap((child) => all(child)),
  ];
  const find = (predicate) => {
    const found = all().find(predicate);
    assert.ok(found, 'Expected rendered control');
    return found;
  };
  const text = () =>
    all()
      .map((el) => el.text)
      .join(' ');
  return { app, find, text };
}
const settle = async () => {
  await new Promise(setImmediate);
  await vue.nextTick();
};

test('book progress renders latest, history, reloads, and reports failed requests', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  let fail = false;
  const calls = [];
  const entry = {
    progressPercent: 25,
    pageNumber: 30,
    source: 'manual',
    occurredDate: '2026-11-17',
  };
  const view = mount(
    async (url) => {
      calls.push(url);
      if (fail) throw Error('network');
      return {
        data: {
          latest: entry,
          history: [{ id: 'one', ...entry }],
          hasMore: false,
        },
      };
    },
    { bookId: 'book/one', refreshKey: 0 },
  );
  try {
    await settle();
    assert.equal(calls[0], '/api/books/book%2Fone/progress');
    assert.match(
      view.text(),
      /Latest progress:.*25.0%.*Page 30.*2026-11-17.*Manually logged/,
    );
    assert.match(view.text(), /Progress history \(1\)/);
    fail = true;
    await view
      .find(
        (el) => el.type === 'button' && el.text.trim() === 'Refresh progress',
      )
      .props.onClick();
    await settle();
    assert.match(view.text(), /Could not load progress/);
    fail = false;
    await view
      .find((el) => el.type === 'button' && el.text.trim() === 'Retry')
      .props.onClick();
    await settle();
    assert.match(view.text(), /Latest progress:/);
  } finally {
    view.app.unmount();
    globalThis.window = previousWindow;
  }
});

test('a slower progress response cannot replace a newer refresh', async () => {
  const previousWindow = globalThis.window;
  let focus;
  globalThis.window = {
    addEventListener(_event, callback) {
      focus = callback;
    },
    removeEventListener() {},
  };
  const pending = [];
  const view = mount(() => new Promise((resolve) => pending.push(resolve)), {
    bookId: 'book',
    refreshKey: 0,
  });
  const result = (percent) => ({
    data: {
      latest: {
        progressPercent: percent,
        pageNumber: null,
        source: 'reader',
        occurredDate: '2026-11-17',
      },
      history: [],
      hasMore: false,
    },
  });
  try {
    focus();
    assert.equal(pending.length, 2);
    pending[1](result(65));
    await settle();
    pending[0](result(10));
    await settle();
    assert.match(view.text(), /65.0%/);
    assert.doesNotMatch(view.text(), /10.0%/);
  } finally {
    view.app.unmount();
    globalThis.window = previousWindow;
  }
});
