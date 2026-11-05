import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const { parse, compileScript } = createRequire(
  import.meta.resolve('nuxt/package.json'),
)('@vue/compiler-sfc');
const { descriptor } = parse(
  readFileSync(
    new URL('../app/components/Books/TbrRationaleEditor.vue', import.meta.url),
    'utf8',
  ),
);
const compiled = compileScript(descriptor, {
  id: 'tbr-editor-test',
  inlineTemplate: true,
});
const code = transformSync(
  `import {ref, watch, nextTick, onMounted, onBeforeUnmount} from 'vue';\n${compiled.content}`,
  { loader: 'ts', format: 'cjs' },
).code;

function mount(fetch, props) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '$fetch', code)(
    () => vue,
    module,
    module.exports,
    fetch,
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
    parentNode: (el) => el.parent,
    nextSibling: () => null,
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

test('the real rationale editor retains a failed draft, retries it, and cancels without saving', async () => {
  const previous = globalThis.document;
  const previousDocumentClass = globalThis.Document;
  globalThis.Document = class {
    activeElement = null;
  };
  globalThis.document = new globalThis.Document();
  let fail = true;
  const calls = [];
  const emitted = [];
  const view = mount(
    async (_url, options) => {
      calls.push(options.body.rationale);
      if (fail) throw Error('network unavailable');
      return { data: { rationale: options.body.rationale.trim() } };
    },
    {
      bookId: 'one',
      rationale: 'Original',
      onSaved: (value) => emitted.push(value),
    },
  );
  try {
    await settle();
    await view
      .find((el) => el.props['aria-label'] === 'Edit your TBR rationale')
      .props.onClick();
    await settle();
    view
      .find((el) => el.type === 'textarea')
      .props['onUpdate:modelValue']('Keep this draft');
    await view
      .find((el) => el.type === 'form')
      .props.onSubmit({ preventDefault() {} });
    await settle();
    assert.equal(
      view.find((el) => el.type === 'textarea').value,
      'Keep this draft',
    );
    assert.match(view.text(), /Your draft is kept/);
    assert.deepEqual(emitted, []);
    fail = false;
    await view
      .find((el) => el.type === 'form')
      .props.onSubmit({ preventDefault() {} });
    await settle();
    assert.deepEqual(calls, ['Keep this draft', 'Keep this draft']);
    assert.deepEqual(emitted, ['Keep this draft']);
    assert.match(view.text(), /Keep this draft/);
    await view
      .find((el) => el.props['aria-label'] === 'Edit your TBR rationale')
      .props.onClick();
    await settle();
    view
      .find((el) => el.type === 'textarea')
      .props['onUpdate:modelValue']('Discard this');
    view
      .find(
        (el) =>
          el.type === 'button' &&
          [el.text, ...el.children.map((child) => child.text)]
            .join(' ')
            .trim() === 'Cancel',
      )
      .props.onClick();
    await settle();
    assert.match(view.text(), /Keep this draft/);
    assert.equal(calls.length, 2);
  } finally {
    view.app.unmount();
    globalThis.document = previous;
    globalThis.Document = previousDocumentClass;
  }
});

test('book details load the saved rationale and offer retry after a failed read', async () => {
  let reads = 0;
  const view = mount(
    async () => {
      if (++reads === 1) throw Error('network unavailable');
      return { data: { rationale: 'Saved on the queue page' } };
    },
    { bookId: 'one' },
  );
  try {
    await settle();
    assert.match(view.text(), /Could not load/);
    await view
      .find(
        (el) =>
          el.type === 'button' &&
          [el.text, ...el.children.map((child) => child.text)]
            .join(' ')
            .trim() === 'Retry',
      )
      .props.onClick();
    await settle();
    assert.match(view.text(), /Saved on the queue page/);
    assert.equal(reads, 2);
  } finally {
    view.app.unmount();
  }
});
