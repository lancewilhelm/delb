import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const { parse, compileScript } = createRequire(
  import.meta.resolve('nuxt/package.json'),
)('@vue/compiler-sfc') as typeof import('@vue/compiler-sfc');

// Compile the actual SFC, including its template and Nuxt's Vue auto-imports.
const source = readFileSync(
  new URL('./EntityPaginationControl.vue', import.meta.url),
  'utf8',
);
const { descriptor, errors } = parse(source);
assert.deepEqual(errors, []);
const compiled = compileScript(descriptor, {
  id: 'pagination-test',
  inlineTemplate: true,
});
const code = transformSync(
  `import { ref, watch, onBeforeUnmount } from 'vue';\n${compiled.content}`,
  { loader: 'ts', format: 'cjs' },
).code;
const module = { exports: {} as { default: vue.Component } };
new Function('require', 'module', 'exports', code)(
  (name: string) => {
    assert.equal(name, 'vue');
    return vue;
  },
  module,
  module.exports,
);
const control = module.exports.default;

type HostNode = {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: HostNode[];
  parent: HostNode | null;
};
const node = (type: string): HostNode => ({
  type,
  text: '',
  props: {},
  children: [],
  parent: null,
});
const renderer = vue.createRenderer<HostNode, HostNode>({
  createElement: node,
  createText: (text) => Object.assign(node('#text'), { text }),
  createComment: (text) => Object.assign(node('#comment'), { text }),
  setText: (el, text) => {
    el.text = text;
  },
  setElementText: (el, text) => {
    el.text = text;
    el.children = [];
  },
  parentNode: (el) => el.parent,
  nextSibling: (el) => {
    if (!el.parent) return null;
    return el.parent.children[el.parent.children.indexOf(el) + 1] ?? null;
  },
  patchProp: (el, key, _previous, value) => {
    el.props[key] = value;
  },
  insert: (child, parent, anchor) => {
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
  remove: (child) => {
    if (child.parent)
      child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = null;
  },
});

class MockObserver {
  static instances: MockObserver[] = [];
  disconnected = false;
  target: unknown;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    MockObserver.instances.push(this);
  }
  observe(target: Element) {
    this.target = target;
  }
  disconnect() {
    this.disconnected = true;
  }
  fire(isIntersecting = true) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function mount() {
  const root = vue.markRaw(node('scroll-root'));
  const container = node('container');
  const props = vue.reactive({
    root: root as unknown as HTMLElement,
    rowCount: 8,
    hasMore: true,
    loading: false,
    error: null as string | null,
  });
  let loads = 0;
  let retries = 0;
  const app = renderer.createApp({
    render: () =>
      vue.h(control, {
        ...props,
        onLoad: () => loads++,
        onRetry: () => retries++,
      }),
  });
  app.mount(container);
  const find = (type: string): HostNode | undefined => {
    const visit = (current: HostNode): HostNode | undefined =>
      current.type === type
        ? current
        : current.children.map(visit).find(Boolean);
    return visit(container);
  };
  return {
    root,
    container,
    props,
    app,
    find,
    counts: () => ({ loads, retries }),
  };
}

test('observer uses the scroll root, rearms when rows change, and ignores stale callbacks', async () => {
  const previous = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver =
    MockObserver as unknown as typeof IntersectionObserver;
  MockObserver.instances = [];
  const view = mount();
  try {
    await vue.nextTick();
    const first = MockObserver.instances[0]!;
    assert.equal(first.options?.root, view.root);
    assert.equal(vue.toRaw(first.target), view.find('div'));
    first.fire(false);
    assert.equal(view.counts().loads, 0);
    first.fire();
    assert.equal(view.counts().loads, 1);
    view.props.rowCount = 16;
    await vue.nextTick();
    const second = MockObserver.instances[1]!;
    assert.equal(first.disconnected, true);
    assert.equal(second.options?.root, view.root);
    first.fire();
    first.fire();
    assert.equal(view.counts().loads, 1);
    second.fire();
    assert.equal(view.counts().loads, 2);
    view.props.error = 'Network error';
    await vue.nextTick();
    assert.equal(second.disconnected, true);
    second.fire();
    second.fire();
    assert.equal(view.counts().loads, 2);
    assert.equal(MockObserver.instances.length, 2);
    assert.equal(view.find('p')?.props.role, 'alert');
    assert.equal(view.find('button')?.text, 'Retry');
    (view.find('button')?.props.onClick as () => void)();
    assert.deepEqual(view.counts(), { loads: 2, retries: 1 });
  } finally {
    view.app.unmount();
    globalThis.IntersectionObserver = previous;
  }
});

test('without IntersectionObserver the native button remains available for manual loading and retry', async () => {
  const previous = globalThis.IntersectionObserver;
  delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
  const view = mount();
  try {
    await vue.nextTick();
    const button = view.find('button')!;
    assert.equal(button.props.type, 'button');
    assert.equal(button.text, 'Load more');
    (button.props.onClick as () => void)();
    assert.deepEqual(view.counts(), { loads: 1, retries: 0 });
    view.props.loading = true;
    await vue.nextTick();
    assert.equal(button.props['aria-disabled'], true);
    (button.props.onClick as () => void)();
    assert.equal(view.counts().loads, 1);
    view.props.loading = false;
    view.props.error = 'Network error';
    await vue.nextTick();
    assert.equal(button.text, 'Retry');
    (button.props.onClick as () => void)();
    assert.deepEqual(view.counts(), { loads: 1, retries: 1 });
  } finally {
    view.app.unmount();
    if (previous) globalThis.IntersectionObserver = previous;
  }
});

test('a focused button remains in place after the final page until blur', async () => {
  const view = mount();
  try {
    await vue.nextTick();
    const button = view.find('button')!;
    (button.props.onFocus as () => void)();
    view.props.hasMore = false;
    await vue.nextTick();
    assert.equal(view.find('button'), button);
    assert.equal(button.text, 'All loaded');
    assert.equal(button.props['aria-disabled'], true);
    (button.props.onClick as () => void)();
    assert.equal(view.counts().loads, 0);
    (button.props.onBlur as () => void)();
    await vue.nextTick();
    assert.equal(view.find('button'), undefined);
  } finally {
    view.app.unmount();
  }
});
