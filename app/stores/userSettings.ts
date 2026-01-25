export type MetadataProviderKey = 'googleBooks' | 'hardcover';

export type BookDeleteMode = 'db_only' | 'everything';

export const fontFamilyOptions = [
  'Fira Code',
  'Geist',
  'IBM Plex Mono',
  'Inter',
  'Montserrat',
  'Nunito',
  'Poppins',
  'Roboto Mono',
] as const;
export type FontFamily = (typeof fontFamilyOptions)[number];

export const funboxModes = ['confetti', 'snow'];
export type FunboxMode = (typeof funboxModes)[number];

export type ReaderTheme = 'system' | 'light' | 'gray' | 'shadow' | 'app';

export interface BaseUserSettings {
  theme?: string;
  fontFamily: FontFamily;
  favoriteThemes: string[];
  themeSorting: {
    sortedByName: boolean;
    reverseSort: boolean;
  };
  funboxModes: FunboxMode[];
  coverStyle: {
    glossySpine: boolean;
    roundedRight: boolean;
    grayscale: boolean;
  };

  /**
   * Grid appearance options (book grid view).
   * - coverSizing: "static" keeps fixed-width thumbnails (current behavior)
   * - coverSizing: "dynamic" makes thumbnails expand/shrink to fill row width
   * - coverWidthPresetPx: base width used by grid layout (default: 172px)
   */
  bookGrid: {
    dynamicCoverSizing: boolean;
    coverWidthPresetPx: number;
    gap: number;
    showTitle: boolean;
    showAuthors: boolean;
    showSeries: boolean;
  };

  /**
   * Per-user metadata search provider selection.
   * Used by the metadata search modal to search one or more providers at once.
   */
  metadataSearch: {
    providers: MetadataProviderKey[];
  };

  /**
   * Per-user default for deleting a book.
   * - db_only: delete database rows only (leaves library folder untouched)
   * - everything: delete database rows and remove the book folder under `library/`
   *
   * Used by the book detail delete confirmation modal to preselect the option.
   */
  bookDelete: {
    defaultMode: BookDeleteMode;
  };

  /**
   * Reader settings
   */
  reader: {
    fontSize: number;
    lineHeight: number;
    fontFamily: string;
    displayMode: 'pages' | 'scroll';
    theme: ReaderTheme;
  };
}

export interface MobileSettingsConfig {
  enabled: boolean;
  searchButton: boolean;
  settings: BaseUserSettings;
}

export interface UserSettings extends BaseUserSettings {
  mobile: MobileSettingsConfig;
}

function getBaseDefaults(): BaseUserSettings {
  return {
    fontFamily: 'Nunito',
    favoriteThemes: [],
    themeSorting: {
      sortedByName: false,
      reverseSort: false,
    },
    funboxModes: [],
    coverStyle: {
      glossySpine: true,
      roundedRight: false,
      grayscale: false,
    },
    bookGrid: {
      dynamicCoverSizing: true,
      coverWidthPresetPx: 172,
      gap: 12,
      showTitle: true,
      showAuthors: true,
      showSeries: true,
    },
    metadataSearch: {
      // Default to Google Books; Hardcover will be enabled client-side only if available.
      providers: ['googleBooks'],
    },
    // Product decision: default to deleting everything from disk to avoid orphaned library folders.
    bookDelete: {
      defaultMode: 'everything',
    },
    reader: {
      fontSize: 100,
      lineHeight: 120,
      fontFamily: 'Serif',
      displayMode: 'pages',
      theme: 'app',
    },
  };
}

function getDefaultSettings(): UserSettings {
  const base = getBaseDefaults();
  return {
    ...base,
    mobile: {
      enabled: false,
      searchButton: true,
      settings: cloneValue(base),
    },
  };
}

type SettingsApiGetResponse = {
  success: boolean;
  data?: {
    userSettings: {
      settings: unknown;
      updatedAt: string | number | Date;
    } | null;
    globalSettings: unknown;
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as T;
  }
  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneValue(entry);
    }
    return cloned as T;
  }
  return value;
}

function mergeRecord(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const baseValue = base[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      merged[key] = mergeRecord(baseValue, overrideValue);
      continue;
    }
    merged[key] = overrideValue;
  }

  return merged;
}

function applyOverrides(
  base: BaseUserSettings,
  overrides: Partial<BaseUserSettings>,
): BaseUserSettings {
  return mergeRecord(
    base as unknown as Record<string, unknown>,
    overrides as unknown as Record<string, unknown>,
  ) as unknown as BaseUserSettings;
}

function normalizeReaderTheme(theme: unknown): ReaderTheme {
  if (theme === 'dark') return 'gray';
  if (theme === 'system') return 'system';
  if (theme === 'light') return 'light';
  if (theme === 'gray') return 'gray';
  if (theme === 'shadow') return 'shadow';
  if (theme === 'app') return 'app';
  return 'app';
}

function normalizeReaderSettings(settings: BaseUserSettings): BaseUserSettings {
  return {
    ...settings,
    reader: {
      ...settings.reader,
      theme: normalizeReaderTheme(settings.reader?.theme),
    },
  };
}

function normalizeSettings(remote: Partial<UserSettings>): UserSettings {
  const baseDefaults = getBaseDefaults();
  const defaults = getDefaultSettings();
  const merged = mergeRecord(
    defaults as unknown as Record<string, unknown>,
    remote as unknown as Record<string, unknown>,
  ) as unknown as UserSettings;

  const mobileBase = isPlainObject(merged.mobile)
    ? merged.mobile
    : defaults.mobile;

  const base = getBaseSettings(merged);
  const normalizedBase = normalizeReaderSettings(base);
  const legacyOverrides = isPlainObject(
    (mobileBase as unknown as Record<string, unknown>).overrides,
  )
    ? ((mobileBase as unknown as Record<string, unknown>)
        .overrides as Partial<BaseUserSettings>)
    : null;

  const mobileSettings = isPlainObject(mobileBase.settings)
    ? (mergeRecord(
        cloneValue(baseDefaults) as unknown as Record<string, unknown>,
        mobileBase.settings as unknown as Record<string, unknown>,
      ) as unknown as BaseUserSettings)
    : legacyOverrides
      ? applyOverrides(normalizedBase, legacyOverrides)
      : cloneValue(baseDefaults);

  return {
    ...merged,
    ...normalizedBase,
    mobile: {
      enabled: !!mobileBase.enabled,
      searchButton: !!mobileBase.searchButton,
      settings: normalizeReaderSettings(mobileSettings),
    },
  };
}

function getBaseSettings(settings: UserSettings): BaseUserSettings {
  const { mobile, ...base } = settings;
  return base;
}

function getSettingValue<T>(
  settings: BaseUserSettings,
  path: string,
): T | undefined {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>(
    (acc, key) => {
      if (!acc || typeof acc !== 'object') return undefined;
      return (acc as Record<string, unknown>)[key];
    },
    settings as unknown as Record<string, unknown>,
  ) as T | undefined;
}

function buildSettingsPatch(
  path: string,
  value: unknown,
): Partial<BaseUserSettings> {
  if (!path) return {};
  const keys = path.split('.');
  let patch: unknown = value;
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const key = keys[i] as string;
    patch = { [key]: patch };
  }
  return patch as Partial<BaseUserSettings>;
}

export const useUserSettingsStore = defineStore(
  'userSettings',
  () => {
    const settings = ref<UserSettings>(getDefaultSettings());
    const isMobile = useIsMobileDevice();
    const activeSettings = computed<BaseUserSettings>(() => {
      const base = getBaseSettings(settings.value);
      if (settings.value.mobile.enabled && isMobile.value) {
        return settings.value.mobile.settings;
      }
      return base;
    });

    /** Returns whether the user is on mobile and using mobile overrides */
    const usingMobileOverrides = computed(
      () => settings.value.mobile.enabled && isMobile.value,
    );

    /**
     * Push the full user settings blob to the server.
     * Keep this intentionally lightweight; server stores JSON.
     */
    async function push() {
      const { session } = useAuth();
      if (!session.value) return;

      await $fetch('/api/settings/user', {
        method: 'PUT',
        body: {
          settings: settings.value,
          updatedAt: updatedAt.value,
        },
      });

      synced.value = true;
    }

    /**
     * Pull latest settings from the server and hydrate locally.
     * Server is the source of truth on load.
     */
    async function pull() {
      const { session } = useAuth();
      if (!session.value) return;

      const res = await $fetch<SettingsApiGetResponse>('/api/settings', {
        method: 'GET',
      });

      const remote = res?.data?.userSettings;
      if (!remote) return;

      // Apply remote settings without triggering a push.
      applyRemoteSettings(
        remote.settings as Partial<UserSettings>,
        remote.updatedAt,
      );
    }

    /**
     * Apply remote settings without re-triggering network writes.
     * Use this for initial hydration and server responses.
     */
    function applyRemoteSettings(
      remote: Partial<UserSettings>,
      remoteUpdatedAt?: string | number | Date,
    ) {
      if (!remote || Object.keys(remote).length === 0) return;

      settings.value = normalizeSettings({ ...settings.value, ...remote });
      updatedAt.value = remoteUpdatedAt
        ? new Date(remoteUpdatedAt)
        : new Date();
      synced.value = true;
    }

    /**
     * Debounced push to avoid spamming the API (e.g. sliders/range inputs).
     * Note: This only affects *network writes*; local state updates remain immediate.
     */
    const debouncedPush = useDebounceFn(async () => {
      try {
        await push();
      } catch (err) {
        // Keep unsynced so a later pull/push can reconcile.
        console.error('Failed to push user settings:', err);
      }
    }, 400);

    /**
     * Force an immediate push (useful on "commit" style interactions).
     */
    async function flushPush() {
      try {
        await push();
      } catch (err) {
        // Keep unsynced so a later pull/push can reconcile.
        console.error('Failed to push user settings:', err);
      }
    }

    function setMobileEnabled(
      enabled: boolean,
      opts?: { immediate?: boolean },
    ) {
      const baseSettings = getBaseSettings(settings.value);
      const nextMobileSettings =
        enabled && !settings.value.mobile.enabled
          ? (cloneValue(baseSettings) as BaseUserSettings)
          : settings.value.mobile.settings;

      settings.value = normalizeSettings({
        ...settings.value,
        mobile: {
          ...settings.value.mobile,
          enabled,
          settings: nextMobileSettings,
        },
      });
      updatedAt.value = new Date();
      synced.value = false;

      if (opts?.immediate) {
        void flushPush();
        return;
      }
      debouncedPush();
    }

    async function updateMobileSettingsPatch(
      updated: Partial<BaseUserSettings>,
      opts?: { immediate?: boolean },
    ) {
      if (!updated || Object.keys(updated).length === 0) return;

      const nextMobileSettings = mergeRecord(
        settings.value.mobile.settings as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
      ) as unknown as BaseUserSettings;

      settings.value = normalizeSettings({
        ...settings.value,
        mobile: {
          ...settings.value.mobile,
          settings: nextMobileSettings,
        },
      });
      updatedAt.value = new Date();
      synced.value = false;

      if (opts?.immediate) {
        await flushPush();
        return;
      }
      debouncedPush();
    }

    /**
     * Local user intent update: optimistic update + debounced push to server.
     */
    async function updateSettings(
      updated: Partial<BaseUserSettings>,
      opts?: { immediate?: boolean },
    ) {
      if (!updated || Object.keys(updated).length === 0) return;

      const baseSettings = getBaseSettings(settings.value);

      const nextBaseSettings = usingMobileOverrides.value
        ? baseSettings
        : (mergeRecord(
            baseSettings as unknown as Record<string, unknown>,
            updated as unknown as Record<string, unknown>,
          ) as unknown as BaseUserSettings);

      const nextMobileSettings = usingMobileOverrides.value
        ? (mergeRecord(
            settings.value.mobile.settings as unknown as Record<
              string,
              unknown
            >,
            updated as unknown as Record<string, unknown>,
          ) as unknown as BaseUserSettings)
        : settings.value.mobile.settings;

      settings.value = normalizeSettings({
        ...settings.value,
        ...nextBaseSettings,
        mobile: {
          ...settings.value.mobile,
          settings: nextMobileSettings,
        },
      });
      updatedAt.value = new Date();
      synced.value = false;

      if (opts?.immediate) {
        await flushPush();
        return;
      }
      debouncedPush();
    }

    function updateSettingAtPath(
      path: string,
      value: unknown,
      opts?: { immediate?: boolean },
    ) {
      const patch = buildSettingsPatch(path, value);
      if (Object.keys(patch).length === 0) return;
      return updateSettings(patch, opts);
    }

    function settingRef<T>(path: string, opts?: { immediate?: boolean }) {
      return computed<T>({
        get: () => getSettingValue<T>(activeSettings.value, path) as T,
        set: (value) => {
          void updateSettingAtPath(path, value, opts);
        },
      });
    }

    function mobileSettingRef<T>(path: string, opts?: { immediate?: boolean }) {
      if (path === 'enabled') {
        return computed<T>({
          get: () => settings.value.mobile.enabled as T,
          set: (value) => {
            setMobileEnabled(!!value, opts);
          },
        });
      }

      return computed<T>({
        get: () =>
          getSettingValue<T>(settings.value.mobile.settings, path) as T,
        set: (value) => {
          const patch = buildSettingsPatch(path, value);
          if (Object.keys(patch).length === 0) return;
          void updateMobileSettingsPatch(patch, opts);
        },
      });
    }

    const updatedAt = ref<Date>(new Date(0));
    const synced = ref(true);

    function $reset() {
      settings.value = getDefaultSettings();
      updatedAt.value = new Date(0);
      synced.value = true;
    }

    return {
      settings,
      activeSettings,
      usingMobileOverrides,
      updatedAt,
      synced,
      updateSettings,
      updateSettingAtPath,
      settingRef,
      mobileSettingRef,
      setMobileEnabled,
      flushPush,
      applyRemoteSettings,
      pull,
      push,
      $reset,
    };
  },
  {
    persist: true,
  },
);
