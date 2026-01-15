import { defineStore } from 'pinia';
import { useDebounceFn } from '@vueuse/core';

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
}

export interface MobileSettingsConfig {
  enabled: boolean;
  overrides: Partial<BaseUserSettings>;
}

export interface UserSettings extends BaseUserSettings {
  mobile: MobileSettingsConfig;
}

function getDefaultSettings(): UserSettings {
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
    mobile: {
      enabled: false,
      overrides: {},
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

function arraysEqual<T>(left: T[], right: T[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
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
    base as Record<string, unknown>,
    overrides as Record<string, unknown>,
  ) as BaseUserSettings;
}

function diffRecord(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};

  for (const [key, nextValue] of Object.entries(next)) {
    const baseValue = base[key];

    if (Array.isArray(nextValue) && Array.isArray(baseValue)) {
      if (!arraysEqual(nextValue, baseValue)) {
        diff[key] = nextValue;
      }
      continue;
    }

    if (isPlainObject(nextValue) && isPlainObject(baseValue)) {
      const nested = diffRecord(baseValue, nextValue);
      if (Object.keys(nested).length > 0) {
        diff[key] = nested;
      }
      continue;
    }

    if (nextValue !== baseValue) {
      diff[key] = nextValue;
    }
  }

  return diff;
}

function diffSettings(
  base: BaseUserSettings,
  next: BaseUserSettings,
): Partial<BaseUserSettings> {
  return diffRecord(
    base as Record<string, unknown>,
    next as Record<string, unknown>,
  ) as Partial<BaseUserSettings>;
}

function normalizeSettings(remote: Partial<UserSettings>): UserSettings {
  const defaults = getDefaultSettings();

  return {
    ...defaults,
    ...remote,
    themeSorting: {
      ...defaults.themeSorting,
      ...remote.themeSorting,
    },
    coverStyle: {
      ...defaults.coverStyle,
      ...remote.coverStyle,
    },
    bookGrid: {
      ...defaults.bookGrid,
      ...remote.bookGrid,
    },
    metadataSearch: {
      ...defaults.metadataSearch,
      ...remote.metadataSearch,
    },
    bookDelete: {
      ...defaults.bookDelete,
      ...remote.bookDelete,
    },
    mobile: {
      ...defaults.mobile,
      ...remote.mobile,
      overrides: remote.mobile?.overrides ?? defaults.mobile.overrides,
    },
  };
}

function getBaseSettings(settings: UserSettings): BaseUserSettings {
  const { mobile, ...base } = settings;
  return base;
}

export const useUserSettingsStore = defineStore(
  'userSettings',
  () => {
    const settings = ref<UserSettings>(getDefaultSettings());
    const isMobile = useIsMobileDevice();
    const activeSettings = computed<BaseUserSettings>(() => {
      const base = getBaseSettings(settings.value);
      if (settings.value.mobile.enabled && isMobile.value) {
        return applyOverrides(base, settings.value.mobile.overrides);
      }
      return base;
    });
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
        : ({ ...baseSettings, ...updated } as BaseUserSettings);
      const currentMobileActive = applyOverrides(
        baseSettings,
        settings.value.mobile.overrides,
      );
      const nextMobileActive = usingMobileOverrides.value
        ? ({ ...currentMobileActive, ...updated } as BaseUserSettings)
        : currentMobileActive;
      const nextOverrides = diffSettings(nextBaseSettings, nextMobileActive);

      settings.value = normalizeSettings({
        ...settings.value,
        ...nextBaseSettings,
        mobile: {
          ...settings.value.mobile,
          overrides: nextOverrides,
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

    async function updateMobileSettings(
      updated: Partial<MobileSettingsConfig>,
      opts?: { immediate?: boolean },
    ) {
      if (!updated || Object.keys(updated).length === 0) return;

      const baseSettings = getBaseSettings(settings.value);
      const currentMobileActive = applyOverrides(
        baseSettings,
        settings.value.mobile.overrides,
      );
      const nextOverrides =
        updated.overrides ?? diffSettings(baseSettings, currentMobileActive);

      settings.value = normalizeSettings({
        ...settings.value,
        mobile: {
          ...settings.value.mobile,
          ...updated,
          overrides: nextOverrides,
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
      updateMobileSettings,
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
