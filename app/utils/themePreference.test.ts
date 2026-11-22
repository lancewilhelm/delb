import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { computed, reactive, ref, watch } from 'vue';
import { defaultThemePreference, resolveTheme } from './themePreference';
import { buildSpaBootScript } from './spaBootScript';

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
  let mount: () => void = () => {
    throw new Error('Mount hook was not registered');
  };
  const pluginModule = {
    exports: {} as {
      default: (app: { hook: (name: string, callback: () => void) => void }) => void;
    },
  };
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
  pluginModule.exports.default({
    hook(name, callback) {
      assert.equal(name, 'app:mounted');
      mount = callback;
    },
  });
  assert.equal(applied.length, 0);
  mount();
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

test('SPA boot script applies stored preset, system, custom, mobile, and font preferences synchronously', () => {
  type FakeElement = {
    tagName: string;
    id: string;
    rel: string;
    href: string;
    textContent: string;
    remove: () => void;
  };

  function runBoot({
    stored,
    dark = false,
    userAgent = 'Mozilla/5.0 (Macintosh)',
    pathname = '/',
  }: {
    stored?: string | null;
    dark?: boolean;
    userAgent?: string;
    pathname?: string;
  }) {
    const elements: FakeElement[] = [];
    const head = {
      appendChild(el: FakeElement) {
        elements.push(el);
      },
    };
    const document = {
      head,
      getElementById(id: string) {
        return elements.find((el) => el.id === id) ?? null;
      },
      createElement(tag: string): FakeElement {
        const el: FakeElement = {
          tagName: tag.toUpperCase(),
          id: '',
          rel: '',
          href: '',
          textContent: '',
          remove() {
            const idx = elements.indexOf(el);
            if (idx >= 0) elements.splice(idx, 1);
          },
        };
        return el;
      },
    };
    runInNewContext(buildSpaBootScript(), {
      localStorage: {
        getItem: (key: string) =>
          key === 'delb.userSettings' ? (stored ?? null) : null,
      },
      matchMedia: () => ({ matches: dark }),
      window: {
        matchMedia: () => ({ matches: dark }),
      },
      navigator: { userAgent },
      location: { pathname },
      document,
    });
    return {
      themeEl: elements.find((el) => el.id === 'currentTheme'),
      fontEl: elements.find((el) => el.id === 'currentFontFamilyStyle'),
    };
  }

  // Default system mode (light + dark)
  assert.equal(
    runBoot({ dark: false }).themeEl?.href,
    '/css/themes/guage_light.css',
  );
  assert.equal(
    runBoot({ dark: true }).themeEl?.href,
    '/css/themes/guage_dark.css',
  );

  // System mode with custom light theme + preset dark theme
  const customStored = JSON.stringify({
    settings: {
      themePreference: {
        mode: 'system',
        fixed: 'paper',
        light: 'custom',
        dark: 'guage_dark',
      },
      customTheme: { bgColor: '#123456' },
      fontFamily: 'Inter',
    },
  });
  const lightCustom = runBoot({ stored: customStored, dark: false });
  assert.equal(lightCustom.themeEl?.tagName, 'STYLE');
  assert.ok(lightCustom.themeEl?.textContent.includes('--bg-color:#123456;'));
  assert.ok(lightCustom.fontEl?.textContent.includes('font-family: Inter'));

  const darkPreset = runBoot({ stored: customStored, dark: true });
  assert.equal(darkPreset.themeEl?.tagName, 'LINK');
  assert.equal(darkPreset.themeEl?.href, '/css/themes/guage_dark.css');

  // Auth routes keep default Geist font
  const loginBoot = runBoot({ stored: customStored, pathname: '/login' });
  assert.ok(
    loginBoot.fontEl?.textContent.includes('font-family: Geist, sans-serif'),
  );

  // Fixed mode + mobile override
  const mobileStored = JSON.stringify({
    settings: {
      themePreference: {
        mode: 'fixed',
        fixed: 'paper',
        light: 'guage_light',
        dark: 'guage_dark',
      },
      mobile: {
        enabled: true,
        settings: {
          themePreference: {
            mode: 'fixed',
            fixed: 'nord',
            light: 'guage_light',
            dark: 'guage_dark',
          },
        },
      },
    },
  });
  assert.equal(
    runBoot({ stored: mobileStored, userAgent: 'Mozilla/5.0 (Macintosh)' })
      .themeEl?.href,
    '/css/themes/paper.css',
  );
  assert.equal(
    runBoot({ stored: mobileStored, userAgent: 'Mozilla/5.0 (iPhone)' })
      .themeEl?.href,
    '/css/themes/nord.css',
  );

  // Corrupted localStorage falls back cleanly without throwing
  assert.equal(
    runBoot({ stored: '{not-valid-json', dark: false }).themeEl?.href,
    '/css/themes/guage_light.css',
  );
});
