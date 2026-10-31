import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { computed, reactive, ref, watch } from 'vue';
import { defaultThemePreference, resolveTheme } from './themePreference';

test('system changes, previews, fixed selection and resuming system resolve through one watcher', () => {
  const store = reactive({
    activeSettings: {
      themePreference: defaultThemePreference(),
      customTheme: undefined,
    },
    updateSettings(patch: {
      themePreference: ReturnType<typeof defaultThemePreference>;
    }) {
      this.activeSettings.themePreference = patch.themePreference;
    },
  });
  const states = new Map<string, ReturnType<typeof ref>>();
  const useState = (key: string, initial: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(initial()));
    return states.get(key);
  };
  const composableSource = readFileSync(
    new URL('../composables/useThemeAppearance.ts', import.meta.url),
    'utf8',
  ).replace(/^import .*;\n/gm, '');
  const composableModule = {
    exports: {} as typeof import('../composables/useThemeAppearance'),
  };
  runInNewContext(
    transformSync(composableSource, { loader: 'ts', format: 'cjs' }).code,
    {
      module: composableModule,
      exports: composableModule.exports,
      useUserSettingsStore: () => store,
      useState,
      computed,
      resolveTheme,
    },
  );
  const appearance = composableModule.exports.useThemeAppearance();
  let change!: (event: { matches: boolean }) => void;
  const media = {
    matches: false,
    addEventListener: (_name: string, fn: typeof change) => {
      change = fn;
    },
  };
  const applied: string[] = [];
  const pluginSource = readFileSync(
    new URL('../plugins/init-theme.client.ts', import.meta.url),
    'utf8',
  );
  const pluginModule = { exports: {} as { default: () => void } };
  runInNewContext(
    transformSync(pluginSource, { loader: 'ts', format: 'cjs' }).code,
    {
      module: pluginModule,
      exports: pluginModule.exports,
      defineNuxtPlugin: (fn: () => void) => fn,
      useUserSettingsStore: () => store,
      useThemeAppearance: () => appearance,
      window: { matchMedia: () => media },
      watch,
      loadTheme: (theme: string) => {
        applied.push(theme);
        return Promise.resolve();
      },
      console,
    },
  );
  pluginModule.exports.default();
  assert.equal(applied.at(-1), 'guage_light');
  change({ matches: true });
  assert.equal(applied.at(-1), 'guage_dark');
  appearance.assignSlot('dark', 'custom');
  assert.equal(applied.at(-1), 'custom');
  appearance.preview.value = 'paper';
  assert.equal(applied.at(-1), 'paper');
  change({ matches: false });
  assert.equal(applied.at(-1), 'paper');
  appearance.preview.value = null;
  assert.equal(applied.at(-1), 'guage_light');
  appearance.selectFixed('paper');
  change({ matches: true });
  assert.equal(applied.at(-1), 'paper');
  assert.equal(store.activeSettings.themePreference.dark, 'custom');
  appearance.useSystem();
  assert.equal(applied.at(-1), 'custom');
});

test('server renders media-gated preset and custom styles for the chosen profile', () => {
  const preference = {
    ...defaultThemePreference(),
    light: 'custom',
    dark: 'guage_dark',
  };
  let head:
    | {
        style: { id: string; media?: string; textContent: string }[];
        link: { id: string; media?: string; href: string }[];
      }
    | undefined;
  const source = readFileSync(
    new URL('../plugins/init-theme.server.ts', import.meta.url),
    'utf8',
  ).replace(/import .*;\n/g, '');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as { default: () => void } };
  runInNewContext(code, {
    module,
    exports: module.exports,
    resolveTheme,
    customThemeCss: () => ':root{--bg-color:#123456}',
    useUserSettingsStore: () => ({
      activeSettings: { themePreference: preference, customTheme: {} },
    }),
    useHead: (value: typeof head) => {
      head = value;
    },
    defineNuxtPlugin: (fn: () => void) => fn,
  });
  module.exports.default();
  assert.equal(head?.style[0]?.id, 'systemThemeLight');
  assert.equal(head?.style[0]?.media, '(prefers-color-scheme: light)');
  assert.equal(head?.link[0]?.href, '/css/themes/guage_dark.css');
  assert.equal(head?.link[0]?.media, '(prefers-color-scheme: dark)');
  preference.mode = 'fixed';
  preference.fixed = 'paper';
  module.exports.default();
  assert.equal(head?.link[0]?.id, 'currentTheme');
  assert.equal(head?.link[0]?.href, '/css/themes/paper.css');
  assert.equal(head?.link[0]?.media, undefined);
  assert.equal(head?.style.length, 0);
});
