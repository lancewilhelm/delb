import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { createPinia, defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { normalizeCustomTheme } from '../utils/customTheme';

type FetchOptions = { body: { settings: { theme: string }; updatedAt: Date } };

function createStore(
  fetch: (url: string, options: FetchOptions) => Promise<unknown>,
  now: () => number = () => Date.now(),
) {
  const source = readFileSync(
    new URL('./userSettings.ts', import.meta.url),
    'utf8',
  ).replace(/import [\s\S]*?from '~\/utils\/customTheme';/, '');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as typeof import('./userSettings') };
  const session = ref<{ id: string } | null>({ id: 'first' });
  runInNewContext(code, {
    module,
    exports: module.exports,
    defineStore,
    computed,
    ref,
    normalizeCustomTheme,
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
  await store.updateSettings({ theme: 'paper' });
  resolvePull({
    data: {
      userSettings: {
        settings: { fontFamily: 'Inter' },
        updatedAt: '2030-01-01T00:00:10.000Z',
      },
    },
  });
  await pull;
  assert.equal(store.settings.theme, 'paper');
  assert.equal(store.settings.fontFamily, 'Inter');
  assert.ok(
    new Date(store.updatedAt).getTime() >
      Date.parse('2030-01-01T00:00:10.000Z'),
  );
  assert.equal(store.synced, false);
});

test('reversed immediate pushes retain the latest edit and guard sync state', async () => {
  const requests: {
    body: { settings: { theme: string }; updatedAt: Date };
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
  const first = store.updateSettings({ theme: 'paper' }, { immediate: true });
  const second = store.updateSettings({ theme: 'dark' }, { immediate: true });
  assert.equal(requests.length, 2);
  let serverRevision = 0;
  let serverTheme = '';
  for (const request of [requests[1]!, requests[0]!]) {
    const revision = new Date(request.body.updatedAt).getTime();
    if (serverRevision < revision) {
      serverRevision = revision;
      serverTheme = request.body.settings.theme;
    }
    request.resolve();
    await Promise.resolve();
  }
  await Promise.all([first, second]);
  assert.equal(serverTheme, 'dark');
  assert.equal(store.synced, true);

  const third = store.updateSettings({ theme: 'paper' }, { immediate: true });
  await store.updateSettings({ theme: 'dark' });
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
  await store.updateSettings({ theme: 'paper' }, { immediate: true });
  assert.equal(store.synced, false);
});

test('SQLite preserves millisecond order and reports rejected writes', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const { and, eq, lt, sql } = await import('drizzle-orm');
  const { userSettings } = await import('../utils/db/schema');
  const client = createClient({ url: ':memory:' });
  try {
    await client.execute(
      'CREATE TABLE user_settings (user_id TEXT PRIMARY KEY, settings TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    );
    await client.execute(
      "INSERT INTO user_settings VALUES ('first', '{}', 1700000000)",
    );
    await client.execute(
      readFileSync(
        new URL(
          '../../.drizzle/migrations/0005_user_settings_timestamp_ms.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    assert.equal(
      (await client.execute('SELECT updated_at FROM user_settings')).rows[0]
        ?.updated_at,
      1700000000000,
    );
    const cloudDb = drizzle(client);
    const source = readFileSync(
      new URL('../../server/api/settings/user.put.ts', import.meta.url),
      'utf8',
    ).replace(/^import .*;\n/gm, '');
    const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
    const module = {
      exports: {} as {
        default: (event: unknown) => Promise<{
          accepted: boolean;
          data: { settings: { theme: string }; updatedAt: Date };
        }>;
      },
    };
    runInNewContext(code, {
      module,
      exports: module.exports,
      and,
      eq,
      lt,
      sql,
      cloudDb,
      userSettings,
      auth: { api: { getSession: async () => ({ user: { id: 'first' } }) } },
      logger: { debug() {}, error() {} },
      defineEventHandler: (handler: unknown) => handler,
      readBody: async (event: { body: unknown }) => event.body,
      setResponseStatus() {},
    });
    const put = (theme: string, revision: number) =>
      module.exports.default({
        headers: {},
        body: { settings: { theme }, updatedAt: revision },
      });
    const base = 1700000001000;
    assert.equal((await put('latest', base + 2)).accepted, true);
    const rejected = await put('older', base + 1);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.data.settings.theme, 'latest');
    assert.equal(new Date(rejected.data.updatedAt).getTime(), base + 2);
    assert.equal((await put('other client', base + 3)).accepted, true);
    assert.equal((await put('same millisecond', base + 3)).accepted, false);
    assert.equal(
      (await client.execute('SELECT updated_at FROM user_settings')).rows[0]
        ?.updated_at,
      base + 3,
    );
    assert.equal((await put('other client', base + 3)).accepted, true);
    let clock = base + 1000;
    const adapter = (_url: string, options: FetchOptions) =>
      module.exports.default({
        headers: {},
        body: JSON.parse(JSON.stringify(options.body)),
      });
    const firstTab = createStore(adapter, () => clock).store;
    const secondTab = createStore(adapter, () => clock).store;
    for (let index = 0; index < 100; index++)
      await firstTab.updateSettings({ theme: `rapid-${index}` });
    assert.ok(new Date(firstTab.updatedAt).getTime() <= clock + 100);
    await firstTab.push();
    assert.equal(firstTab.synced, true);
    clock += 1000;
    await secondTab.updateSettings(
      { theme: 'later second tab' },
      { immediate: true },
    );
    assert.equal(secondTab.synced, true);
    await firstTab.push();
    assert.equal(firstTab.synced, true);
    assert.equal(firstTab.settings.theme, 'later second tab');
    const stored = await client.execute('SELECT settings FROM user_settings');
    assert.equal(
      JSON.parse(String(stored.rows[0]?.settings)).theme,
      'later second tab',
    );
    const thirdTab = createStore(adapter, () => clock).store;
    thirdTab.applyRemoteSettings(
      { theme: 'later second tab', fontFamily: 'Nunito' },
      new Date(clock + 1),
    );
    await thirdTab.updateSettings({ fontFamily: 'Inter' });
    assert.equal((await put('new remote theme', clock + 2)).accepted, true);
    await thirdTab.push();
    assert.equal(thirdTab.synced, true);
    const reconciled = await client.execute(
      'SELECT settings FROM user_settings',
    );
    const reconciledSettings = JSON.parse(String(reconciled.rows[0]?.settings));
    assert.equal(reconciledSettings.theme, 'new remote theme');
    assert.equal(reconciledSettings.fontFamily, 'Inter');
  } finally {
    client.close();
  }
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
  store.applyRemoteSettings({ theme: 'paper' }, new Date(1000));
  const write = store.updateSettings({ theme: 'dark' }, { immediate: true });
  const read = store.pull();
  resolvePut({ success: true, accepted: true });
  await write;
  const acknowledged = new Date(store.updatedAt).getTime();
  resolveGet({
    data: {
      userSettings: { settings: { theme: 'paper' }, updatedAt: new Date(1000) },
    },
  });
  await read;
  assert.equal(store.settings.theme, 'dark');
  assert.equal(new Date(store.updatedAt).getTime(), acknowledged);
  assert.equal(store.synced, true);
});
