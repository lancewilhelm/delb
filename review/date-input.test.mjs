import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileScript, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const dateInput = await import('../app/utils/dateInput.ts');

const { descriptor } = parse(
  readFileSync(
    new URL('../app/components/ui/UiDateInput.vue', import.meta.url),
    'utf8',
  ),
);
const code = transformSync(
  compileScript(descriptor, { id: 'date-input-test', inlineTemplate: true })
    .content,
  { loader: 'ts', format: 'cjs' },
).code;

function mount(props) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name === 'vue') return vue;
      if (name === '~/utils/dateInput') return dateInput;
      throw new Error(`Unexpected require: ${name}`);
    },
    module,
    module.exports,
  );
  const node = (type, text = '') => ({
    type,
    text,
    value: '',
    validity: { badInput: false },
    props: {},
    children: [],
    parent: null,
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
  const commits = [];
  const state = vue.reactive({ modelValue: '2020-01-01', ...props });
  const app = renderer.createApp({
    render: () =>
      vue.h(module.exports.default, {
        ...state,
        onCommit: (value) => commits.push(value),
        'onUpdate:modelValue': (value) => {
          state.modelValue = value;
        },
      }),
  });
  app.component('Icon', { render: () => null });
  app.mount(container);
  const all = (parent = container) => [
    parent,
    ...parent.children.flatMap((child) => all(child)),
  ];
  const input = () => all().find((el) => el.type === 'input');
  const type = (value, { badInput = false } = {}) => {
    const el = input();
    el.value = value;
    el.validity.badInput = badInput;
    el.props.onInput({ target: el });
  };
  return { app, all, input, type, commits, state };
}

const tick = () => vue.nextTick();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('typing a year digit by digit commits only the complete date', async () => {
  const view = mount({ commitDelayMs: 20 });
  view.input().props.onFocus();
  for (const partial of ['0002-05-14', '0020-05-14', '0202-05-14']) {
    view.type(partial);
    await wait(30);
  }
  assert.deepEqual(view.commits, []);
  assert.equal(view.input().props.disabled, false);
  view.type('2024-05-14');
  await wait(30);
  assert.deepEqual(view.commits, ['2024-05-14']);
  view.app.unmount();
});

test('a new value from the parent does not replace the draft while focused', async () => {
  const view = mount({ commitDelayMs: 1000 });
  view.input().props.onFocus();
  view.type('2024-05-1');
  view.state.modelValue = '1999-01-01';
  await tick();
  assert.equal(view.input().value, '2024-05-1');
  view.app.unmount();
});

test('blur and Enter commit at once, and an incomplete date reverts', async () => {
  const view = mount({ commitDelayMs: 1000 });
  view.input().props.onFocus();
  view.type('2023-07-04');
  view.input().props.onKeydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(view.commits, ['2023-07-04']);

  view.type('', { badInput: true });
  view.input().props.onBlur();
  await tick();
  assert.deepEqual(view.commits, ['2023-07-04']);
  assert.equal(view.input().value, '2023-07-04');
  view.app.unmount();
});

test('an emptied field or the clear button clears the date', async () => {
  const view = mount({ clearable: true, commitDelayMs: 1000 });
  view.input().props.onFocus();
  view.type('');
  view.input().props.onBlur();
  assert.deepEqual(view.commits, ['']);

  view.state.modelValue = '2022-02-02';
  await tick();
  const clear = view
    .all()
    .find((el) => el.type === 'button' && el.props['aria-label']);
  assert.ok(clear, 'clear button');
  clear.props.onClick();
  assert.deepEqual(view.commits, ['', '']);
  view.app.unmount();
});
