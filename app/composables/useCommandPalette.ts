import fuzzysort from "fuzzysort";
import themesList from "~/assets/json/themes.json";

interface Theme {
  name: string;
  bgColor: string;
  mainColor: string;
  subColor: string;
  textColor: string;
}

export interface Option {
  label: string;
  icon?: string;
  action?: () => void;
  options?: Option[];
  active?: boolean | Ref<boolean>;
}

export function useCommandPalette() {
  const query = ref("");
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

  const options = ref<Option[]>([
    { label: "theme", icon: "lucide:palette" },
    { label: "favorite themes", icon: "lucide:star" },
    {
      label: "add current theme to favorites",
      icon: "lucide:heart",
      action: addCurrentThemeToFavorites,
    },
    {
      label: "give me a random theme",
      icon: "lucide:dice-5",
      action: () => {
        const randomTheme =
          allThemes.value[Math.floor(Math.random() * allThemes.value.length)];
        if (!randomTheme) return;
        useUserSettingsStore().updateSettings({ theme: randomTheme.name });
        closePalette();
      },
    },
    {
      label: "font family",
      icon: "ri:font-family",
      options: getFontFamilyOptions(),
    },
    {
      label: "settings",
      icon: "lucide:settings",
      action: () => {
        useUiStore().setCommandPaletteVisible(false);
        navigateTo("/settings");
      },
    },
    {
      label: "log out",
      icon: "lucide:log-out",
      action: () => useAuth().signOut(),
    },
  ]);

  const filteredOptions = computed<Option[]>(() => {
    const list = selectedOption.value?.options ?? options.value;
    if (!query.value) return list;
    return fuzzysort.go(query.value, list, { key: "label" }).map((r) => r.obj);
  });

  const filteredThemes = computed<Theme[]>(() => {
    if (selectedOption.value?.label === "favorite themes") {
      const favoriteThemes = allThemes.value.filter((t) => {
        const userSettingsStore = useUserSettingsStore();
        const settings = userSettingsStore.settings;
        return settings.favoriteThemes?.includes(t.name);
      });
      if (!query.value) {
        return favoriteThemes;
      } else {
        return fuzzysort
          .go(query.value, favoriteThemes, { key: "name" })
          .map((r) => r.obj);
      }
    }
    if (!query.value) return allThemes.value;
    return fuzzysort
      .go(query.value, allThemes.value, { key: "name" })
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
    query.value = "";
    highlightedIndex.value = 0;
  }

  function selectOption(option?: Option) {
    if (!option) return;

    if (option.action) {
      option.action();
      closePalette();
    } else if (option.options) {
      selectedOption.value = option;
      query.value = "";
      highlightedIndex.value = 0;
    } else if (option.label === "theme" || option.label === "favorite themes") {
      selectedOption.value = option;
      query.value = "";
      highlightedIndex.value = 0;
    }
  }

  function selectTheme(theme?: Theme) {
    if (!theme) return;
    useUserSettingsStore().updateSettings({ theme: theme.name });
    closePalette();
  }

  function previewTheme(theme?: string) {
    if (!theme) {
      hoveredTheme.value = null;
      loadTheme(useUserSettingsStore().settings.theme);
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
      selectedOption.value?.label === "theme" ||
      selectedOption.value?.label === "favorite themes"
    ) {
      // This branch is for Theme selection
      const themes = filteredThemes.value;
      if (themes.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        highlightedIndex.value = (highlightedIndex.value + 1) % themes.length;
        debouncedPreviewTheme(themes[highlightedIndex.value]?.name);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        highlightedIndex.value =
          (highlightedIndex.value - 1 + themes.length) % themes.length;
        debouncedPreviewTheme(themes[highlightedIndex.value]?.name);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (
          highlightedIndex.value >= 0 &&
          highlightedIndex.value < themes.length
        ) {
          selectTheme(themes[highlightedIndex.value]); // type: Theme
        }
      } else if (event.key === "Delete") {
        if (selectedOption?.value.label === "favorite themes") {
          useUserSettingsStore().updateSettings({
            favoriteThemes:
              useUserSettingsStore().settings.favoriteThemes.filter(
                (t: string) => t !== themes[highlightedIndex.value]?.name,
              ),
          });
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        selectedOption.value = undefined;
        query.value = "";
        highlightedIndex.value = 0;
        previewTheme(useUserSettingsStore().settings.theme);
      }
    } else {
      // This branch is for Option selection
      const opts = filteredOptions.value;
      if (opts.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        highlightedIndex.value = (highlightedIndex.value + 1) % opts.length;
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        highlightedIndex.value =
          (highlightedIndex.value - 1 + opts.length) % opts.length;
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (
          highlightedIndex.value >= 0 &&
          highlightedIndex.value < opts.length
        ) {
          selectOption(opts[highlightedIndex.value]); // type: Option
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (selectedOption.value) {
          selectedOption.value = undefined;
          query.value = "";
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
    const userSettingsStore = useUserSettingsStore();
    if (
      selectedOption.value?.label !== "theme" &&
      selectedOption.value?.label !== "favorite themes"
    )
      return;
    const currentTheme = userSettingsStore.settings.theme;
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
      if (label === "theme") scrollToCurrentThemeIfOpen();
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
  const settings = userSettingsStore.settings;
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
    active: computed(() => userSettingsStore.settings.fontFamily === font),
  }));
}
