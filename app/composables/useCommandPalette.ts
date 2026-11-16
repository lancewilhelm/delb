import fuzzysort from 'fuzzysort';
import themesList from '~/assets/json/themes.json';
import { normalizeCustomTheme } from '~/utils/customTheme';
import {
  DEFAULT_APPEARANCE_CONTRAST,
  MIN_APPEARANCE_CONTRAST,
  MAX_APPEARANCE_CONTRAST,
} from '~/utils/appearanceContrast';
import { searchPaletteOptions } from '~/utils/commandPaletteSearch';

interface Theme {
  name: string;
  bgColor: string;
  mainColor: string;
  subColor: string;
  textColor: string;
}

interface Slider {
  model: unknown;
  min: number;
  max: number;
  suffix: string;
  step?: number;
}

interface Toggle {
  model: unknown;
}

export interface Option {
  label: string;
  icon?: string;
  action?: () => void;
  options?: Option[];
  active?: boolean | Ref<boolean>;
  slider?: Slider | null;
  toggle?: Toggle | null;
  numberInput?: {
    model: number | string | null | Ref<number>;
    description?: string;
  };
  panel?: 'custom-theme' | 'grid-fields' | 'list-fields';
  themePicker?: 'fixed' | 'favorites' | 'light' | 'dark';
}

export function useCommandPalette() {
  const query = ref('');
  const selectedOption = ref<Option>();
  const navigation = shallowRef<Option[]>([]);
  const themePickerOpen = computed(() => !!selectedOption.value?.themePicker);
  const highlightedIndex = ref(0);
  const rowRefs = ref<HTMLElement[]>([]);
  const inputRef = ref<HTMLInputElement | null>(null);
  const optionsRef = ref<HTMLDivElement | null>(null);
  const hoveredTheme = ref<string | null>(null);
  const appearance = useThemeAppearance();

  const sortedThemesList = [...themesList].sort((a: Theme, b: Theme) =>
    a.name.localeCompare(b.name),
  );
  const allThemes = computed<Theme[]>(() =>
    [
      ...sortedThemesList,
      {
        name: 'custom',
        ...normalizeCustomTheme(userSettingsStore.activeSettings.customTheme),
      },
    ].sort((a, b) => a.name.localeCompare(b.name)),
  );

  const uiStore = useUiStore();
  const userSettingsStore = useUserSettingsStore();

  const options = ref<Option[]>([
    {
      label: 'search',
      icon: 'lucide:search',
      action: () => {
        uiStore.setGlobalSearchVisible(true);
      },
    },
    {
      label: 'add book',
      icon: 'lucide:book-plus',
      action: () => {
        uiStore.setAddBookModalVisible(true);
      },
    },
    { label: 'theme', icon: 'lucide:palette', themePicker: 'fixed' },
    { label: 'favorite themes', icon: 'lucide:star', themePicker: 'favorites' },
    { label: 'system light theme', icon: 'lucide:sun', themePicker: 'light' },
    { label: 'system dark theme', icon: 'lucide:moon', themePicker: 'dark' },
    {
      label: 'follow system appearance',
      icon: 'lucide:monitor',
      action: () => {
        appearance.useSystem();
        closePalette();
      },
      active: computed(
        () =>
          userSettingsStore.activeSettings.themePreference.mode === 'system',
      ),
    },
    {
      label: 'edit custom theme colors',
      icon: 'lucide:paintbrush',
      panel: 'custom-theme',
    },
    {
      label: 'contrast',
      icon: 'lucide:contrast',
      slider: {
        model: userSettingsStore.settingRef<number>('appearanceContrast'),
        min: MIN_APPEARANCE_CONTRAST,
        max: MAX_APPEARANCE_CONTRAST,
        step: 5,
        suffix: '%',
      },
    },
    {
      label: 'reset contrast',
      icon: 'lucide:rotate-ccw',
      action: () => {
        void userSettingsStore.updateSettings({
          appearanceContrast: DEFAULT_APPEARANCE_CONTRAST,
        });
        closePalette();
      },
    },
    {
      label: 'theme sorting',
      icon: 'lucide:arrow-down-a-z',
      options: [
        { label: 'name ascending', sortedByName: true, reverseSort: false },
        { label: 'name descending', sortedByName: true, reverseSort: true },
        {
          label: 'brightness ascending',
          sortedByName: false,
          reverseSort: false,
        },
        {
          label: 'brightness descending',
          sortedByName: false,
          reverseSort: true,
        },
      ].map(({ label, sortedByName, reverseSort }) => ({
        label,
        active: computed(() => {
          const sorting = userSettingsStore.activeSettings.themeSorting;
          return (
            sorting.sortedByName === sortedByName &&
            sorting.reverseSort === reverseSort
          );
        }),
        action: () => {
          void userSettingsStore.updateSettings({
            themeSorting: { sortedByName, reverseSort },
          });
          closePalette();
        },
      })),
    },
    {
      label: 'add current theme to favorites',
      icon: 'lucide:heart',
      action: addCurrentThemeToFavorites,
    },
    {
      label: 'give me a random theme',
      icon: 'lucide:dice-5',
      action: () => {
        const randomTheme =
          allThemes.value[Math.floor(Math.random() * allThemes.value.length)];
        if (!randomTheme) return;
        appearance.selectFixed(randomTheme.name);
        closePalette();
      },
    },
    {
      label: 'font family',
      icon: 'ri:font-family',
      options: getFontFamilyOptions(),
    },
    {
      label: 'cover style',
      icon: 'lucide:book-image',
      options: [
        {
          label: 'glossy effect',
          icon: 'mage:stars-b-fill',
          toggle: {
            model: userSettingsStore.settingRef<boolean>(
              'coverStyle.glossySpine',
            ),
          },
        },
        {
          label: 'spine gloss',
          icon: 'lucide:sparkles',
          toggle: {
            model: userSettingsStore.settingRef<boolean>(
              'coverStyle.detailSpineGloss',
            ),
          },
        },
        {
          label: 'reading status badges',
          icon: 'lucide:badge-check',
          toggle: {
            model: userSettingsStore.settingRef<boolean>(
              'coverStyle.showReadingStatus',
            ),
          },
        },
        {
          label: 'copy indicators',
          icon: 'lucide:copy',
          toggle: {
            model: userSettingsStore.settingRef<boolean>(
              'coverStyle.showCopyIndicators',
            ),
          },
        },
        ...(['authors', 'series', 'publishers', 'tags'] as const).map(
          (name) => ({
            label: `${name} max cover count`,
            icon: 'lucide:images',
            numberInput: {
              model: userSettingsStore.settingRef<number>(
                `coverStyle.${name}MaxCovers`,
              ),
              description: 'Use -1 for no limit.',
            },
          }),
        ),
        {
          label: 'rounded right corners',
          icon: 'lucide:log-in',
          toggle: {
            model: userSettingsStore.settingRef<boolean>(
              'coverStyle.roundedRight',
            ),
          },
        },
        {
          label: 'grayscale filter',
          icon: 'lucide:palette',
          toggle: {
            model: userSettingsStore.settingRef<boolean>(
              'coverStyle.grayscale',
            ),
          },
        },
      ],
    },
    {
      label: 'book grid',
      icon: 'lucide:grid',
      options: [
        {
          label: 'dynamic cover size',
          icon: 'lucide:arrow-left-right',
          toggle: {
            model: userSettingsStore.settingRef<boolean>(
              'bookGrid.dynamicCoverSizing',
            ),
          },
        },
        {
          label: 'min cover size',
          icon: 'lucide:ruler-dimension-line',
          slider: {
            model: computed({
              get: () =>
                userSettingsStore.activeSettings.bookGrid.coverWidthPresetPx,
              set: (v: number) => {
                userSettingsStore.updateSettings({
                  bookGrid: {
                    ...userSettingsStore.activeSettings.bookGrid,
                    coverWidthPresetPx: Math.round(v),
                  },
                });
              },
            }),
            min: 100,
            max: 250,
            suffix: 'px',
          },
        },
        {
          label: 'gap between covers',
          icon: 'lucide:align-horizontal-space-around',
          slider: {
            model: computed({
              get: () => userSettingsStore.activeSettings.bookGrid.gap,
              set: (v: number) => {
                userSettingsStore.updateSettings({
                  bookGrid: {
                    ...userSettingsStore.activeSettings.bookGrid,
                    gap: Math.round(v),
                  },
                });
              },
            }),
            min: 2,
            max: 100,
            suffix: 'px',
          },
        },
        {
          label: 'reorder grid fields',
          icon: 'lucide:list-ordered',
          panel: 'grid-fields',
        },
        ...useBookViewFields('grid').paletteOptions,
      ],
    },
    {
      label: 'book list',
      icon: 'lucide:list',
      options: [
        {
          label: 'reorder list fields',
          icon: 'lucide:list-ordered',
          panel: 'list-fields',
        },
        ...useBookViewFields('list').paletteOptions,
        {
          label: 'row height',
          icon: 'lucide:rows',
          slider: {
            model: computed({
              get: () => userSettingsStore.activeSettings.bookList.rowHeightPx,
              set: (v: number) => {
                userSettingsStore.updateSettings({
                  bookList: {
                    ...userSettingsStore.activeSettings.bookList,
                    rowHeightPx: Math.round(v),
                  },
                });
              },
            }),
            min: 56,
            max: 160,
            suffix: 'px',
          },
        },
      ],
    },
    {
      label: 'mobile',
      icon: 'lucide:smartphone',
      options: [
        {
          label: 'separate mobile settings',
          icon: 'lucide:smartphone',
          toggle: {
            model: userSettingsStore.mobileSettingRef<boolean>('enabled'),
          },
        },
        {
          label: 'search button',
          icon: 'lucide:search',
          toggle: {
            model: userSettingsStore.mobileSettingRef<boolean>(
              'mobileSpecific.searchButton',
            ),
          },
        },
      ],
    },
    {
      label: 'reader minimum spread width',
      icon: 'lucide:book-open',
      slider: {
        model: userSettingsStore.settingRef<number>('reader.minSpreadWidth'),
        min: 400,
        max: 5000,
        suffix: 'px',
      },
    },
    {
      label: 'settings',
      icon: 'lucide:settings',
      action: () => {
        useUiStore().setCommandPaletteVisible(false);
        navigateTo('/settings');
      },
    },
    {
      label: 'log out',
      icon: 'lucide:log-out',
      action: () => {
        closePalette();
        return useAuth().signOut();
      },
    },
  ]);

  const filteredOptions = computed(() =>
    searchPaletteOptions(
      selectedOption.value?.options ?? options.value,
      query.value,
    ),
  );

  const filteredThemes = computed<Theme[]>(() => {
    if (selectedOption.value?.themePicker === 'favorites') {
      const favoriteThemes = allThemes.value.filter((t) => {
        const settings = userSettingsStore.activeSettings;
        return settings.favoriteThemes?.includes(t.name);
      });
      if (!query.value) {
        return favoriteThemes;
      } else {
        return fuzzysort
          .go(query.value, favoriteThemes, { key: 'name' })
          .map((r) => r.obj);
      }
    }
    if (!query.value) return allThemes.value;
    return fuzzysort
      .go(query.value, allThemes.value, { key: 'name' })
      .map((r) => r.obj);
  });

  function togglePalette() {
    const uiStore = useUiStore();
    uiStore.setCommandPaletteVisible(!uiStore.commandPaletteVisible);
    if (uiStore.commandPaletteVisible) {
      nextTick(() => {
        inputRef.value?.focus();
        scrollToCurrentThemeIfOpen();
      });
    } else {
      closePalette();
    }
  }

  function closePalette() {
    useUiStore().setCommandPaletteVisible(false);
    selectedOption.value = undefined;
    navigation.value = [];
    query.value = '';
    highlightedIndex.value = 0;
    previewTheme();
  }

  function goBack() {
    selectedOption.value = navigation.value.pop();
    query.value = '';
    highlightedIndex.value = 0;
    previewTheme();
    nextTick(() => inputRef.value?.focus());
  }

  function selectOption(option?: Option) {
    if (!option) return;

    if (option.action) {
      option.action();
      // closePalette();
    } else if (option.toggle) {
      option.toggle.model = !option.toggle.model;
    } else if (
      option.options ||
      option.themePicker ||
      option.slider ||
      option.numberInput ||
      option.panel
    ) {
      if (selectedOption.value) navigation.value.push(selectedOption.value);
      selectedOption.value = option;
      query.value = '';
      highlightedIndex.value = 0;
    }
  }

  function selectTheme(theme?: Theme) {
    if (!theme) return;
    const slot = selectedOption.value?.themePicker;
    if (slot === 'light' || slot === 'dark')
      appearance.assignSlot(slot, theme.name);
    else appearance.selectFixed(theme.name);
    closePalette();
  }

  let previewGeneration = 0;
  function previewTheme(theme?: string) {
    previewGeneration++;
    if (!theme) {
      hoveredTheme.value = null;
      appearance.preview.value = null;
    } else {
      hoveredTheme.value = theme;
      appearance.preview.value = theme;
    }
  }
  const queuePreview = debounce(
    (theme: string | undefined, generation: number) => {
      if (
        generation === previewGeneration &&
        uiStore.commandPaletteVisible &&
        themePickerOpen.value
      ) {
        previewTheme(theme);
      }
    },
    300,
  );
  function debouncedPreviewTheme(theme?: string) {
    queuePreview(theme, ++previewGeneration);
  }

  function handleInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (selectedOption.value) goBack();
      else closePalette();
      return;
    }
    if (themePickerOpen.value) {
      // This branch is for Theme selection
      const themes = filteredThemes.value;
      if (themes.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        highlightedIndex.value = (highlightedIndex.value + 1) % themes.length;
        debouncedPreviewTheme(themes[highlightedIndex.value]?.name);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlightedIndex.value =
          (highlightedIndex.value - 1 + themes.length) % themes.length;
        debouncedPreviewTheme(themes[highlightedIndex.value]?.name);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (
          highlightedIndex.value >= 0 &&
          highlightedIndex.value < themes.length
        ) {
          selectTheme(themes[highlightedIndex.value]); // type: Theme
        }
      } else if (event.key === 'Delete') {
        if (selectedOption.value?.themePicker === 'favorites') {
          userSettingsStore.updateSettings({
            favoriteThemes:
              userSettingsStore.activeSettings.favoriteThemes.filter(
                (t: string) => t !== themes[highlightedIndex.value]?.name,
              ),
          });
        }
      }
    } else {
      // This branch is for Option selection
      const opts = filteredOptions.value;
      if (opts.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        highlightedIndex.value = (highlightedIndex.value + 1) % opts.length;
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlightedIndex.value =
          (highlightedIndex.value - 1 + opts.length) % opts.length;
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (
          highlightedIndex.value >= 0 &&
          highlightedIndex.value < opts.length
        ) {
          selectOption(opts[highlightedIndex.value]?.option);
        }
      }
    }
  }

  function setOptionRef(el: Element | null, i: number) {
    if (el) rowRefs.value[i] = el as HTMLElement;
  }

  function scrollToHighlighted() {
    const container = optionsRef.value;
    const el = rowRefs.value[highlightedIndex.value];
    if (!container || !el) return;

    const headerHeight = 84; // px (from h-12 utility)
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;

    const visibleTop = container.scrollTop + headerHeight;
    const visibleBottom = container.scrollTop + container.clientHeight;

    if (elTop < visibleTop) container.scrollTop = elTop - headerHeight;
    else if (elBottom > visibleBottom)
      container.scrollTop = elBottom - container.clientHeight;
  }

  function scrollToCurrentThemeIfOpen() {
    if (!themePickerOpen.value) return;
    const currentTheme = appearance.resolved.value;
    const idx = filteredThemes.value.findIndex((t) => t.name === currentTheme);
    if (idx !== -1) {
      highlightedIndex.value = idx;
      nextTick(scrollToHighlighted);
    }
  }

  onBeforeUnmount(() => previewTheme());

  // --- Listeners & Watchers
  watch(
    [
      filteredOptions,
      filteredThemes,
      () => useUiStore().commandPaletteVisible,
      selectedOption,
    ],
    () => {
      rowRefs.value = [];
    },
  );

  watch(
    () => uiStore.commandPaletteVisible,
    (open) => {
      if (!open) {
        selectedOption.value = undefined;
        navigation.value = [];
        query.value = '';
        highlightedIndex.value = 0;
        previewTheme();
      }
    },
  );

  watch(highlightedIndex, () => nextTick(scrollToHighlighted));

  watch(themePickerOpen, (open) => {
    if (open) scrollToCurrentThemeIfOpen();
    else {
      previewGeneration++;
      if (hoveredTheme.value) previewTheme();
    }
  });

  watch(
    [filteredOptions, () => useUiStore().commandPaletteVisible, query],
    ([options, open, q]) => {
      if (!open) highlightedIndex.value = 0;
      else if (
        q.length > 0 &&
        (options.length > 0 || filteredThemes.value.length > 0)
      )
        highlightedIndex.value = 0;
      else highlightedIndex.value = -1;
    },
  );

  return {
    query,
    selectedOption,
    themePickerOpen,
    goBack,
    highlightedIndex,
    rowRefs,
    inputRef,
    optionsRef,
    options,
    filteredOptions,
    filteredThemes,
    hoveredTheme,
    togglePalette,
    closePalette,
    selectOption,
    selectTheme,
    handleInputKeydown,
    setOptionRef,
    scrollToHighlighted,
    scrollToCurrentThemeIfOpen,
    debouncedPreviewTheme,
  };
}

// --- Helper Functions
function addCurrentThemeToFavorites() {
  const userSettingsStore = useUserSettingsStore();
  const settings = userSettingsStore.activeSettings;
  const theme = useThemeAppearance().resolved.value;
  if (settings.favoriteThemes?.includes(theme)) return;

  userSettingsStore.updateSettings({
    favoriteThemes: [...(settings.favoriteThemes || []), theme],
  });
}

function getFontFamilyOptions() {
  const userSettingsStore = useUserSettingsStore();
  return fontFamilyOptions.map((font) => ({
    label: font,
    action: () => {
      userSettingsStore.updateSettings({ fontFamily: font });
      useUiStore().setCommandPaletteVisible(false);
    },
    active: computed(
      () => userSettingsStore.activeSettings.fontFamily === font,
    ),
  }));
}
