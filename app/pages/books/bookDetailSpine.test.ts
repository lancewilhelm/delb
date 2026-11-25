import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileScript, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

type HostNode = {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: HostNode[];
  parent: HostNode | null;
  options: HostNode[];
  value: unknown;
  checked: boolean;
  addEventListener: () => void;
  removeEventListener: () => void;
};

const node = (type: string): HostNode => ({
  type,
  text: '',
  props: {},
  children: [],
  parent: null,
  options: [],
  value: '',
  checked: false,
  addEventListener: () => {},
  removeEventListener: () => {},
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

function stubComponent(tag: string) {
  return vue.defineComponent({
    name: tag,
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => vue.h(tag, attrs, slots.default?.());
    },
  });
}

function stubModule(tag: string) {
  return { __esModule: true, default: stubComponent(tag) };
}

function mountBookDetail(opts: {
  showDetailSpine: boolean;
  spineRevision: string | null;
}) {
  const source = readFileSync(
    new URL('./[id]/index.vue', import.meta.url),
    'utf8',
  );
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const compiled = compileScript(descriptor, {
    id: 'book-detail-test',
    inlineTemplate: true,
  });
  const code = transformSync(compiled.content, {
    loader: 'ts',
    format: 'cjs',
  }).code;

  const activeSettings = vue.reactive({
    coverStyle: {
      glossySpine: true,
      detailSpineGloss: true,
      showDetailSpine: opts.showDetailSpine,
      roundedRight: false,
      grayscale: false,
      showReadingStatus: false,
      showCopyIndicators: false,
    },
    bookDelete: {
      defaultMode: 'everything',
    },
  });

  const bookFixture = {
    id: 'book-1',
    title: 'Dune',
    coverImagePath: 'covers/dune.jpg',
    spineRevision: opts.spineRevision,
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    authors: [{ id: 'author-1', name: 'Frank Herbert' }],
    files: [],
  };

  const modules: Record<string, unknown> = {
    vue,
    '@vueuse/core': { useClipboard: () => ({ copy: () => {} }) },
    'vue-router': {
      RouterLink: stubComponent('router-link'),
      useRoute: () => ({ params: { id: 'book-1' } }),
      useRouter: () => ({ back: () => {} }),
    },
    '~/composables/useHead': { useHead: () => {} },
    '~/stores/collections': {
      useCollectionsStore: () => ({
        collections: [{ id: 'col-1', name: 'Main' }],
        fetchCollections: async () => {},
      }),
    },
    '~/stores/userSettings': {
      useUserSettingsStore: () => ({
        activeSettings,
        updateSettings: async () => {},
      }),
    },
    '~/utils/apiFetch': { $fetch: async () => ({}) },
    '~/utils/navigation': { navigateTo: () => {} },
    '~/utils/covers': {
      buildBookCoverUrl: ({
        bookId,
        variant,
      }: {
        bookId: string;
        variant: string;
      }) => `/api/books/${bookId}/cover?variant=${variant}`,
    },
    '~/utils/bookPreviewCache': {
      fetchBookDetail: async () => bookFixture,
      getBookPreview: () => bookFixture,
      invalidateBookDetail: () => {},
    },
    '~/utils/dashboardCache': { clearDashboardCache: () => {} },
    '~/utils/downloadFilename': { readDownloadFilename: () => null },
    '~/utils/descriptionHtml': { sanitizeDescriptionHtml: (s: string) => s },
    '~/components/AppHeader.vue': stubModule('app-header'),
    '~/components/BookCover.vue': stubModule('book-cover'),
    '~/components/Books/BookMoveModal.vue': stubModule('book-move-modal'),
    '~/components/Books/BookNotes.vue': stubModule('book-notes'),
    '~/components/Books/BookReviewEditor.vue': stubModule('book-review-editor'),
    '~/components/Books/BookPersonalShelves.vue': stubModule(
      'book-personal-shelves',
    ),
    '~/components/Books/BookProgressHistory.vue': stubModule(
      'book-progress-history',
    ),
    '~/components/Books/TbrRationaleEditor.vue': stubModule(
      'tbr-rationale-editor',
    ),
    '~/components/HoverScrollText.vue': stubModule('hover-scroll-text'),
    '~/components/ModalWindow.vue': stubModule('modal-window'),
    '~/components/ViewSelectorDropdown.vue': stubModule(
      'view-selector-dropdown',
    ),
  };

  const module = { exports: {} as { default: vue.Component } };
  new Function('require', 'module', 'exports', code)(
    (name: string) => {
      if (!(name in modules)) {
        throw new Error(`Unexpected import in book detail page test: ${name}`);
      }
      return modules[name];
    },
    module,
    module.exports,
  );

  const container = node('container');
  const app = renderer.createApp({
    render: () => vue.h(module.exports.default),
  });
  app.component('Icon', stubComponent('icon-stub'));
  app.directive('tooltip', {});
  app.mount(container);

  const findAll = (predicate: (n: HostNode) => boolean): HostNode[] => {
    const matches: HostNode[] = [];
    const visit = (current: HostNode) => {
      if (predicate(current)) matches.push(current);
      for (const child of current.children) visit(child);
    };
    visit(container);
    return matches;
  };

  return { app, activeSettings, findAll };
}

test('book detail page gates spine artwork and image request on coverStyle.showDetailSpine', async () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ success: true, data: { collections: [] } }),
  })) as unknown as typeof fetch;

  const view = mountBookDetail({
    showDetailSpine: true,
    spineRevision: 'rev-1',
  });
  try {
    await vue.nextTick();

    const artworkNodes = () =>
      view.findAll(
        (n) =>
          typeof n.props.class === 'string' &&
          n.props.class.includes('detail-artwork'),
      );
    const spineImages = () =>
      view.findAll(
        (n) =>
          n.type === 'img' &&
          typeof n.props.src === 'string' &&
          n.props.src.includes('/api/books/book-1/spine'),
      );
    const covers = () => view.findAll((n) => n.type === 'book-cover');

    // Enabled by default: spine artwork + spine <img> + cover inside .detail-artwork
    assert.equal(artworkNodes().length, 1);
    assert.equal(spineImages().length, 1);
    assert.equal(
      spineImages()[0]?.props.src,
      '/api/books/book-1/spine?v=rev-1',
    );
    assert.equal(covers().length, 1);

    // Disabled: falls back cleanly to standalone <BookCover> and does not render spine <img>
    view.activeSettings.coverStyle.showDetailSpine = false;
    await vue.nextTick();
    assert.equal(artworkNodes().length, 0);
    assert.equal(spineImages().length, 0);
    assert.equal(covers().length, 1);

    // Re-enabled: spine artwork and spine <img> return
    view.activeSettings.coverStyle.showDetailSpine = true;
    await vue.nextTick();
    assert.equal(artworkNodes().length, 1);
    assert.equal(spineImages().length, 1);
    assert.equal(covers().length, 1);
  } finally {
    view.app.unmount();
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

test('book detail page falls back to standalone cover when book has no spineRevision', async () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ success: true, data: { collections: [] } }),
  })) as unknown as typeof fetch;

  const view = mountBookDetail({
    showDetailSpine: true,
    spineRevision: null,
  });
  try {
    await vue.nextTick();
    const artworkNodes = view.findAll(
      (n) =>
        typeof n.props.class === 'string' &&
        n.props.class.includes('detail-artwork'),
    );
    const spineImages = view.findAll(
      (n) =>
        n.type === 'img' &&
        typeof n.props.src === 'string' &&
        n.props.src.includes('/spine'),
    );
    const covers = view.findAll((n) => n.type === 'book-cover');
    assert.equal(artworkNodes.length, 0);
    assert.equal(spineImages.length, 0);
    assert.equal(covers.length, 1);
  } finally {
    view.app.unmount();
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});
