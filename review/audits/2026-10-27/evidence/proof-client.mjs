import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root =
  process.env.DELB_AUDIT_REPO ||
  (await import('node:path')).resolve(import.meta.dirname, '../../../..');
const require = createRequire(root + '/package.json');
const ts = require('typescript');
for (const name of ['Grid', 'List']) {
  const src = fs.readFileSync(
    `${root}/app/components/Books/BooksInfinite${name}.vue`,
    'utf8',
  );
  const part = src.slice(
    src.indexOf('function reset()'),
    src.indexOf('\nwatch(\n', src.indexOf('async function loadNextPage')),
  );
  let resolve;
  const calls = [];
  const c = {
    props: { collectionId: 'old', endpoint: '/books' },
    books: { value: [] },
    nextCursor: { value: null },
    errorMessage: { value: null },
    lastRangeAnchorId: { value: null },
    scrollContainerRef: { value: null },
    scrollTop: { value: 0 },
    loading: { value: false },
    limit: { value: 10 },
    debugLog() {},
    $fetch: (url, opts) => {
      calls.push(opts.query.collectionId);
      return new Promise((r) => (resolve = r));
    },
    nextTick: async () => {},
    setupObserver() {},
    hasMore: { value: true },
    emit() {},
    console,
  };
  vm.createContext(c);
  vm.runInContext(
    ts.transpile(part, { target: ts.ScriptTarget.ES2020 }) +
      ';globalThis.loadFirstPage=loadFirstPage;',
    c,
  );
  const first = c.loadFirstPage();
  c.props.collectionId = 'new';
  await c.loadFirstPage();
  resolve({ data: { books: [{ id: 'old-book' }], nextCursor: 'old-cursor' } });
  await first;
  console.log(
    name,
    JSON.stringify({
      requests: calls,
      selectedCollection: c.props.collectionId,
      books: c.books.value,
      cursor: c.nextCursor.value,
    }),
  );
}
const s = fs.readFileSync(`${root}/app/pages/books/[id]/read.vue`, 'utf8');
let timer = null,
  saves = [];
const c = {
  setTimeout: (f) => {
    timer = f;
    return 1;
  },
  clearTimeout: () => {
    timer = null;
  },
  saveTimeout: null,
  lastSavedLocation: null,
  saveReadingPosition: (...x) => {
    saves.push(x);
  },
  console,
};
vm.createContext(c);
let source = s.slice(
  s.indexOf('function scheduleSave('),
  s.indexOf('/** Navigate to the previous book page.'),
);
vm.runInContext(
  ts.transpile(source) + ';globalThis.scheduleSave=scheduleSave',
  c,
);
c.scheduleSave('new-cfi', 25);
const pending = Boolean(timer);
vm.runInContext('if (saveTimeout) clearTimeout(saveTimeout)', c);
console.log(
  'unmount',
  JSON.stringify({
    pendingBeforeUnmount: pending,
    pendingAfterUnmount: Boolean(timer),
    saves,
  }),
);
for (const sync of [false, true]) {
  let resolve;
  const displays = [];
  const saved = [];
  const g = {
    setTimeout: (f) => f(),
    bookInstance: {
      locations: {
        generate: () => new Promise((r) => (resolve = r)),
        cfiFromPercentage: () => 'synced-old-cfi',
      },
    },
    savedLocation: 'old-cfi',
    renditionRef: { value: { location: { start: { cfi: 'new-cfi' } } } },
    rendition: {
      display: (x) => {
        displays.push(x);
        return Promise.resolve();
      },
    },
    progressSyncEnabled: { value: sync },
    syncedProgressPercent: { value: sync ? 10 : null },
    extractProgress: (x) => (x === 'old-cfi' ? 10 : sync ? 10 : 25),
    isAwaitingLocations: { value: true },
    currentProgress: { value: 25 },
    saveReadingPosition: (...x) => saved.push(x),
    console,
  };
  vm.createContext(g);
  source = s.slice(
    s.indexOf(
      '      setTimeout(() => {',
      s.indexOf('if (shouldGenerateLocations)'),
    ),
    s.indexOf(
      '\n    }\n\n    showFullscreenTemporarily',
      s.indexOf('if (shouldGenerateLocations)'),
    ),
  );
  vm.runInContext(ts.transpile(source), g);
  resolve();
  await new Promise((r) => setImmediate(r));
  console.log(
    sync ? 'generated-sync' : 'generated',
    JSON.stringify({
      visibleCfi: g.renditionRef.value.location.start.cfi,
      displayCalls: displays,
      progress: g.currentProgress.value,
      saves: saved,
    }),
  );
}
let src = fs
  .readFileSync(`${root}/app/stores/userSettings.ts`, 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/\bexport\s+/g, '');
let resolve;
const settingsContext = {
  defineStore: (id, setup) => setup,
  ref: (v) => ({ value: v }),
  computed: (f) => ({
    get value() {
      return f();
    },
  }),
  useIsMobileDevice: () => ({ value: false }),
  useAuth: () => ({ session: { value: {} } }),
  $fetch: (url, opts) =>
    opts.method === 'GET'
      ? new Promise((r) => (resolve = r))
      : Promise.resolve({}),
  useDebounceFn: () => () => {},
  normalizeCustomTheme: (x) => x,
  console,
};
vm.createContext(settingsContext);
vm.runInContext(
  ts.transpile(src, { target: ts.ScriptTarget.ES2020 }) +
    ';globalThis.store=useUserSettingsStore();',
  settingsContext,
);
const pendingPull = settingsContext.store.pull();
await settingsContext.store.updateSettings({ fontFamily: 'Inter' });
console.log(
  'settings before response',
  settingsContext.store.settings.value.fontFamily,
  settingsContext.store.synced.value,
);
resolve({
  data: {
    userSettings: {
      settings: { fontFamily: 'Nunito' },
      updatedAt: '2020-01-01',
    },
  },
});
await pendingPull;
console.log(
  'settings after response',
  settingsContext.store.settings.value.fontFamily,
  settingsContext.store.synced.value,
  settingsContext.store.updatedAt.value.toISOString(),
);
