import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { createPinia, defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { UserSettings } from './userSettings';
import { defaultCustomTheme, normalizeCustomTheme } from '../utils/customTheme';

// Supply Nuxt auto-imports to exercise the actual store without a Nuxt server.
function createStore() {
  const source = readFileSync(
    new URL('./userSettings.ts', import.meta.url),
    'utf8',
  ).replace(/import [\s\S]*?from '~\/utils\/customTheme';/, '');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const mobile = ref(false);
  const module = {
    exports: {} as typeof import('./userSettings'),
  };
  runInNewContext(code, {
    module,
    exports: module.exports,
    defineStore,
    computed,
    ref,
    normalizeCustomTheme,
    useIsMobileDevice: () => mobile,
    useAuth: () => ({ session: ref(null) }),
    useDebounceFn: () => () => {},
  });
  return { store: module.exports.useUserSettingsStore(createPinia()), mobile };
}

test('legacy settings remain uninitialized until a palette is saved', () => {
  const { store } = createStore();
  assert.equal(store.activeSettings.customTheme, undefined);
  store.applyRemoteSettings({ theme: 'paper', fontFamily: 'Nunito' });
  assert.equal(store.activeSettings.customTheme, undefined);
  store.applyRemoteSettings({
    theme: 'custom',
    customTheme: { bgColor: '#123' },
  } as unknown as Partial<UserSettings>);
  assert.deepEqual(
    JSON.parse(JSON.stringify(store.activeSettings.customTheme)),
    { ...defaultCustomTheme, bgColor: '#112233' },
  );
});

test('custom edits persist independently in default and mobile profiles', async () => {
  const { store, mobile } = createStore();
  await store.updateSettings({
    theme: 'custom',
    customTheme: defaultCustomTheme,
  });
  store.setMobileEnabled(true);
  mobile.value = true;
  await store.updateSettings({
    customTheme: { ...defaultCustomTheme, bgColor: '#112233' },
  });
  assert.equal(store.activeSettings.customTheme?.bgColor, '#112233');
  assert.equal(store.settings.customTheme?.bgColor, '#dddddd');
  mobile.value = false;
  assert.equal(store.activeSettings.customTheme?.bgColor, '#dddddd');
  const saved = JSON.parse(JSON.stringify(store.settings));
  const restored = createStore();
  restored.store.applyRemoteSettings(saved);
  restored.mobile.value = true;
  assert.equal(restored.store.activeSettings.customTheme?.bgColor, '#112233');
  restored.store.$reset();
  assert.equal(restored.store.activeSettings.customTheme, undefined);
});
