import { defaultBookFields, normalizeBookFields } from '../utils/bookFields';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { createPinia, defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { normalizeCustomTheme } from '../utils/customTheme';
import {
  DEFAULT_APPEARANCE_CONTRAST,
  normalizeAppearanceContrast,
} from '../utils/appearanceContrast';
import {
  defaultThemePreference,
  normalizeThemePreference,
} from '../utils/themePreference';

const pref = (fixed: string) => ({
  ...defaultThemePreference(),
  mode: 'fixed' as const,
  fixed,
});
type FetchOptions = {
  body: { settings: { themePreference: { fixed: string } }; updatedAt: Date };
};

function createStore(
  fetch: (url: string, options: FetchOptions) => Promise<unknown>,
  now: () => number = () => Date.now(),
) {
  const source = readFileSync(
    new URL('./userSettings.ts', import.meta.url),
    'utf8',
  )
    .replace(/import [\s\S]*?from '~\/utils\/bookFields';/, '')
    .replace(/import [\s\S]*?from '~\/utils\/customTheme';/, '')
    .replace(/import [\s\S]*?from '~\/utils\/appearanceContrast';/, '')
    .replace(/import [\s\S]*?from '~\/utils\/themePreference';/, '');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as typeof import('./userSettings') };
  const session = ref<{ id: string } | null>({ id: 'first' });
  runInNewContext(code, {
    module,
    exports: module.exports,
    defineStore,
    computed,
    ref,
    defaultBookFields,
    normalizeBookFields,
    normalizeCustomTheme,
    DEFAULT_APPEARANCE_CONTRAST,
    normalizeAppearanceContrast,
    defaultThemePreference,
    normalizeThemePreference,
    Date: class extends Date {
      static override now() {
        return now();
      }
    },
    useIsMobileDevice: () => ref(false),
    useAuth: () => ({ session }),
    useDebounceFn: () => () => {},
    $fetch: fetch,
  });
  return { store: module.exports.useUserSettingsStore(createPinia()), session };
}

test('bookshelf appearance has a brown default and preserves personal choices', async () => {
  const { store } = createStore(async () => ({}));
  assert.equal(store.activeSettings.bookshelfStyle.color, '#895b3b');
  assert.equal(store.activeSettings.bookshelfStyle.texture, 'wood');
  await store.updateSettings({
    bookshelfStyle: { color: '#305a72', texture: 'smooth' },
  });
  assert.equal(store.activeSettings.bookshelfStyle.color, '#305a72');
  assert.equal(store.activeSettings.bookshelfStyle.texture, 'smooth');
  store.applyRemoteSettings(
    { bookshelfStyle: { color: 'not-a-color', texture: 'wood' } },
    new Date('2040-01-01'),
  );
  assert.equal(store.activeSettings.bookshelfStyle.color, '#895b3b');
});

test('persisted timestamp strings survive edits and concurrent pulls', async () => {
  let resolvePull!: (value: unknown) => void;
  const { store } = createStore(
    () =>
      new Promise((resolve) => {
        resolvePull = resolve;
      }),
  );
  store.updatedAt = '2030-01-01T00:00:00.000Z';
  const pull = store.pull();
  await store.updateSettings({ themePreference: pref('paper') });
  resolvePull({
    data: {
      userSettings: {
        settings: { fontFamily: 'Inter' },
        updatedAt: '2030-01-01T00:00:10.000Z',
      },
    },
  });
  await pull;
  assert.equal(store.settings.themePreference.fixed, 'paper');
  assert.equal(store.settings.fontFamily, 'Inter');
  assert.ok(
    new Date(store.updatedAt).getTime() >
      Date.parse('2030-01-01T00:00:10.000Z'),
  );
  assert.equal(store.synced, false);
});

test('reversed immediate pushes retain the latest edit and guard sync state', async () => {
  const requests: {
    body: { settings: { themePreference: { fixed: string } }; updatedAt: Date };
    resolve: () => void;
  }[] = [];
  const { store, session } = createStore(
    (_url, options) =>
      new Promise((resolve) => {
        requests.push({
          body: options.body,
          resolve: () => resolve({ success: true, accepted: true }),
        });
      }),
  );
  const first = store.updateSettings(
    { themePreference: pref('paper') },
    { immediate: true },
  );
  const second = store.updateSettings(
    { themePreference: pref('dark') },
    { immediate: true },
  );
  assert.equal(requests.length, 2);
  let serverRevision = 0;
  let serverTheme = '';
  for (const request of [requests[1]!, requests[0]!]) {
    const revision = new Date(request.body.updatedAt).getTime();
    if (serverRevision < revision) {
      serverRevision = revision;
      serverTheme = request.body.settings.themePreference.fixed;
    }
    request.resolve();
    await Promise.resolve();
  }
  await Promise.all([first, second]);
  assert.equal(serverTheme, 'dark');
  assert.equal(store.synced, true);

  const third = store.updateSettings(
    { themePreference: pref('paper') },
    { immediate: true },
  );
  await store.updateSettings({ themePreference: pref('dark') });
  requests[2]!.resolve();
  await third;
  assert.equal(store.synced, false);

  const fourth = store.push();
  session.value = { id: 'second' };
  requests[3]!.resolve();
  await fourth;
  assert.equal(store.synced, false);
});

test('a rejected write remains unsynced', async () => {
  const { store } = createStore(async () => ({
    success: true,
    accepted: false,
  }));
  await store.updateSettings(
    { themePreference: pref('paper') },
    { immediate: true },
  );
  assert.equal(store.synced, false);
});

test('a delayed pull cannot overwrite an acknowledged local save', async () => {
  let resolvePut!: (value: unknown) => void;
  let resolveGet!: (value: unknown) => void;
  const { store } = createStore(
    (url) =>
      new Promise((resolve) => {
        if (url === '/api/settings/user') resolvePut = resolve;
        else resolveGet = resolve;
      }),
  );
  store.applyRemoteSettings({ themePreference: pref('paper') }, new Date(1000));
  const write = store.updateSettings(
    { themePreference: pref('dark') },
    { immediate: true },
  );
  const read = store.pull();
  resolvePut({ success: true, accepted: true });
  await write;
  const acknowledged = new Date(store.updatedAt).getTime();
  resolveGet({
    data: {
      userSettings: {
        settings: { themePreference: pref('paper') },
        updatedAt: new Date(1000),
      },
    },
  });
  await read;
  assert.equal(store.settings.themePreference.fixed, 'dark');
  assert.equal(new Date(store.updatedAt).getTime(), acknowledged);
  assert.equal(store.synced, true);
});

test('concurrent pull merges showDetailSpine independently of other coverStyle edits', async () => {
  let resolvePull!: (value: unknown) => void;
  const { store } = createStore(
    () =>
      new Promise((resolve) => {
        resolvePull = resolve;
      }),
  );
  store.updatedAt = '2030-01-01T00:00:00.000Z';
  const pull = store.pull();
  const showDetailSpine = store.settingRef<boolean>(
    'coverStyle.showDetailSpine',
  );
  showDetailSpine.value = false;
  resolvePull({
    data: {
      userSettings: {
        settings: {
          coverStyle: { detailSpineGloss: false, showDetailSpine: true },
        },
        updatedAt: '2030-01-01T00:00:10.000Z',
      },
    },
  });
  await pull;
  assert.equal(store.activeSettings.coverStyle.showDetailSpine, false);
  assert.equal(store.activeSettings.coverStyle.detailSpineGloss, false);
  assert.equal(store.synced, false);
});
