import fuzzysort from 'fuzzysort';
import themesList from '~/assets/json/themes.json';

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
}

export function useCommandPalette() {
  const query = ref('');
  const selectedOption = ref<Option>();
  const highlightedIndex = ref(0);
  const rowRefs = ref<HTMLElement[]>([]);
  const inputRef = ref<HTMLInputElement | null>(null);
  const optionsRef = ref<HTMLDivElement | null>(null);
  const hoveredTheme = ref<string | null>(null);

  const sortedThemesList = [...themesList].sort((a: Theme, b: Theme) =>
    a.name.localeCompare(b.name),
  );
  const allThemes = computed<Theme[]>(() => sortedThemesList);

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
    { label: 'theme', icon: 'lucide:palette' },
    { label: 'favorite themes', icon: 'lucide:star' },
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
        userSettingsStore.updateSettings({ theme: randomTheme.name });
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
          label: 'book title',
          icon: 'lucide:book-a',
          toggle: {
            model: userSettingsStore.settingRef<boolean>('bookGrid.showTitle'),
          },
        },
        {
          label: 'book authors',
          icon: 'lucide:user',
          toggle: {
            model: userSettingsStore.settingRef<boolean>(
              'bookGrid.showAuthors',
            ),
          },
        },
        {
          label: 'book series',
          icon: 'lucide:layers',
          toggle: {
            model: userSettingsStore.settingRef<boolean>('bookGrid.showSeries'),
          },
        },
      ],
    },
    {
      label: 'book list',
      icon: 'lucide:list',
      options: [
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
            max: 140,
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

  const filteredOptions = computed<Option[]>(() => {
    const list = selectedOption.value?.options ?? options.value;
    if (!query.value) return list;
    return fuzzysort.go(query.value, list, { key: 'label' }).map((r) => r.obj);
  });

  const filteredThemes = computed<Theme[]>(() => {
    if (selectedOption.value?.label === 'favorite themes') {
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
    query.value = '';
    highlightedIndex.value = 0;
  }

  function selectOption(option?: Option) {
    if (!option) return;

    if (option.action) {
      option.action();
      // closePalette();
    } else if (option.toggle) {
      option.toggle.model = !option.toggle.model;
    } else if (option.options) {
      selectedOption.value = option;
      query.value = '';
      highlightedIndex.value = 0;
    } else if (option.label === 'theme' || option.label === 'favorite themes') {
      selectedOption.value = option;
      query.value = '';
      highlightedIndex.value = 0;
    } else if (option.slider) {
      selectedOption.value = option;
      query.value = '';
    }
  }

  function selectTheme(theme?: Theme) {
    if (!theme) return;
    userSettingsStore.updateSettings({ theme: theme.name });
    closePalette();
  }

  function previewTheme(theme?: string) {
    if (!theme) {
      hoveredTheme.value = null;
      loadTheme(userSettingsStore.activeSettings.theme);
    } else {
      hoveredTheme.value = theme;
      loadTheme(theme);
    }
  }
  const debouncedPreviewTheme = debounce((theme?: string) => {
    previewTheme(theme);
  }, 300);

  function handleInputKeydown(event: KeyboardEvent) {
    if (
      selectedOption.value?.label === 'theme' ||
      selectedOption.value?.label === 'favorite themes'
    ) {
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
        if (selectedOption?.value.label === 'favorite themes') {
          userSettingsStore.updateSettings({
            favoriteThemes:
              userSettingsStore.activeSettings.favoriteThemes.filter(
                (t: string) => t !== themes[highlightedIndex.value]?.name,
              ),
          });
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        selectedOption.value = undefined;
        query.value = '';
        highlightedIndex.value = 0;
        previewTheme(userSettingsStore.activeSettings.theme);
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
          selectOption(opts[highlightedIndex.value]); // type: Option
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (selectedOption.value) {
          selectedOption.value = undefined;
          query.value = '';
          highlightedIndex.value = 0;
        } else {
          useUiStore().setCommandPaletteVisible(false);
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
    if (
      selectedOption.value?.label !== 'theme' &&
      selectedOption.value?.label !== 'favorite themes'
    )
      return;
    const currentTheme = userSettingsStore.activeSettings.theme;
    const idx = filteredThemes.value.findIndex((t) => t.name === currentTheme);
    if (idx !== -1) {
      highlightedIndex.value = idx;
      nextTick(scrollToHighlighted);
    }
  }

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

  watch(highlightedIndex, () => nextTick(scrollToHighlighted));

  watch(
    () => selectedOption.value?.label,
    (label) => {
      if (label === 'theme') scrollToCurrentThemeIfOpen();
    },
  );

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
  if (!settings.theme) return;
  if (settings.favoriteThemes?.includes(settings.theme)) return;

  userSettingsStore.updateSettings({
    favoriteThemes: [...(settings.favoriteThemes || []), settings.theme],
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
