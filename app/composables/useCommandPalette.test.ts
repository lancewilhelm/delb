import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import fuzzysort from 'fuzzysort';
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import { normalizeCustomTheme } from '../utils/customTheme';
import { searchPaletteOptions } from '../utils/commandPaletteSearch';

function createPalette() {
  const source = readFileSync(
    new URL('./useCommandPalette.ts', import.meta.url),
    'utf8',
  )
    .replace(/import[\s\S]*?from 'fuzzysort';/, '')
    .replace(/import themesList from [^;]+;/, '')
    .replace(/import \{ normalizeCustomTheme \} from [^;]+;/, '')
    .replace(/import \{[\s\S]*?\} from '~\/utils\/appearanceContrast';/, '')
    .replace(/import \{ searchPaletteOptions \} from [^;]+;/, '');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const settings = reactive({
    appearanceContrast: 100,
    coverStyle: {
      detailSpineGloss: true,
      showDetailSpine: true,
      showReadingStatus: false,
      authorsMaxCovers: 8,
    },
    themePreference: {
      mode: 'fixed',
      fixed: 'paper',
      light: 'paper',
      dark: 'night',
    },
    themeSorting: { sortedByName: false, reverseSort: false },
    favoriteThemes: [],
    customTheme: undefined,
    bookGrid: { gap: 12, coverWidthPresetPx: 172 },
    bookList: { rowHeightPx: 84 },
  });
  const mobile = reactive({ enabled: false, searchButton: true });
  function settingRef(path: string) {
    if (path === 'coverStyle.authorsMaxCovers') {
      return computed({
        get: () => settings.coverStyle.authorsMaxCovers,
        set: (value: number) => {
          settings.coverStyle.authorsMaxCovers = value;
        },
      });
    }
    if (path === 'coverStyle.showReadingStatus') {
      return computed({
        get: () => settings.coverStyle.showReadingStatus,
        set: (value: boolean) => {
          settings.coverStyle.showReadingStatus = value;
        },
      });
    }
    if (path === 'coverStyle.showDetailSpine') {
      return computed({
        get: () => settings.coverStyle.showDetailSpine,
        set: (value: boolean) => {
          settings.coverStyle.showDetailSpine = value;
        },
      });
    }
    return ref(false);
  }

  const store = {
    activeSettings: settings,
    settingRef,
    mobileSettingRef: (path: string) =>
      computed({
        get: () => (path === 'enabled' ? mobile.enabled : mobile.searchButton),
        set: (value) => {
          if (path === 'enabled') mobile.enabled = value;
          else mobile.searchButton = value;
        },
      }),
    updateSettings: (patch: object) => Object.assign(settings, patch),
  };
  const ui = reactive({
    commandPaletteVisible: true,
    setCommandPaletteVisible(value: boolean) {
      this.commandPaletteVisible = value;
    },
  });
  const appearance = {
    preview: ref(null),
    resolved: ref('paper'),
    selectFixed: (theme: string) => {
      settings.themePreference.mode = 'fixed';
      settings.themePreference.fixed = theme;
    },
    assignSlot: (slot: 'light' | 'dark', theme: string) => {
      settings.themePreference.mode = 'system';
      settings.themePreference[slot] = theme;
    },
    useSystem: () => {
      settings.themePreference.mode = 'system';
    },
  };
  const module = { exports: {} as typeof import('./useCommandPalette') };
  runInNewContext(code, {
    module,
    exports: module.exports,
    computed,
    nextTick,
    reactive,
    ref,
    shallowRef,
    watch,
    fuzzysort,
    normalizeCustomTheme,
    searchPaletteOptions,
    themesList: [{ name: 'paper' }, { name: 'night' }],
    fontFamilyOptions: ['Nunito'],
    DEFAULT_APPEARANCE_CONTRAST: 100,
    MIN_APPEARANCE_CONTRAST: 50,
    MAX_APPEARANCE_CONTRAST: 200,
    useUiStore: () => ui,
    useUserSettingsStore: () => store,
    useThemeAppearance: () => appearance,
    useBookViewFields: () => ({
      paletteOptions: [{ label: 'title', toggle: { model: ref(true) } }],
    }),
    onBeforeUnmount: () => {},
    debounce: (fn: unknown) => fn,
  });
  return { palette: module.exports.useCommandPalette(), settings, ui };
}

test('search results operate the nested setting and preserve back navigation', async () => {
  const { palette, settings } = createPalette();
  palette.query.value = 'reading status badges';
  const result = palette.filteredOptions.value.find(
    (item) => item.option.label === 'reading status badges',
  );
  assert.equal(result?.path, 'cover style');
  palette.selectOption(result?.option);
  assert.equal(settings.coverStyle.showReadingStatus, true);
  palette.query.value = '';
  palette.selectOption(
    palette.filteredOptions.value.find(
      (item) => item.option.label === 'cover style',
    )?.option,
  );
  palette.selectOption(
    palette.filteredOptions.value.find(
      (item) => item.option.label === 'authors max cover count',
    )?.option,
  );
  if (!palette.selectedOption.value?.numberInput)
    throw new Error('Missing number input');
  palette.selectedOption.value.numberInput.model = -1;
  assert.equal(settings.coverStyle.authorsMaxCovers, -1);
  palette.goBack();
  assert.equal(palette.selectedOption.value?.label, 'cover style');
  await nextTick();
});

test('system theme assignment and close retain the intended mode', async () => {
  const { palette, settings, ui } = createPalette();
  palette.selectOption(
    palette.filteredOptions.value.find(
      (item) => item.option.label === 'system dark theme',
    )?.option,
  );
  const theme = palette.filteredThemes.value.find(
    (item) => item.name === 'paper',
  );
  palette.selectTheme(theme);
  assert.equal(settings.themePreference.mode, 'system');
  assert.equal(settings.themePreference.dark, 'paper');
  assert.equal(ui.commandPaletteVisible, false);
  await nextTick();
  assert.equal(palette.selectedOption.value, undefined);
});

test('command palette toggles show spine on book details', () => {
  const { palette, settings } = createPalette();
  palette.query.value = 'show spine on book details';
  const result = palette.filteredOptions.value.find(
    (item) => item.option.label === 'show spine on book details',
  );
  assert.equal(result?.path, 'cover style');
  assert.equal(settings.coverStyle.showDetailSpine, true);
  palette.selectOption(result?.option);
  assert.equal(settings.coverStyle.showDetailSpine, false);
  palette.selectOption(result?.option);
  assert.equal(settings.coverStyle.showDetailSpine, true);
});
