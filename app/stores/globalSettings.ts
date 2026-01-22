import { defineStore } from 'pinia';

export interface GlobalSettings {
  allowRegistration: boolean;

  /**
   * Preferred metadata provider (UI can use this to select a default source).
   */
  metadataProvider?: 'googleBooks' | 'hardcover';

  /**
   * Dropbox ingestion settings (server-side watcher).
   *
   * Stored in global settings so admins can tune behavior without env vars.
   */
  dropbox?: {
    enabled?: boolean;
    dir?: string;
    extensions?: string[] | string;
    pollIntervalMs?: number;
    stablePassesRequired?: number;
    stableMaxAgeMs?: number;

    targetCollectionId?: string;
    targetUserId?: string;
    targetUserEmail?: string;
  };
}

function getDefaultSettings(): GlobalSettings {
  return {
    allowRegistration: false,

    metadataProvider: 'googleBooks',

    dropbox: {
      enabled: true,
      dir: 'dropbox',
      extensions: ['.epub', '.pdf', '.mobi', '.azw3'],
      pollIntervalMs: 2500,
      stablePassesRequired: 2,
      stableMaxAgeMs: 5 * 60 * 1000,
      targetCollectionId: '',
      targetUserId: '',
      targetUserEmail: '',
    },
  };
}

type GlobalSettingsApiGetResponse = {
  success: boolean;
  data?: {
    globalSettings: {
      settings: unknown;
      updatedAt: string | number | Date;
    } | null;
    capabilities?: {
      hardcoverAvailable?: boolean;
    };
  };
};

type GlobalSettingsApiPutResponse = {
  success: boolean;
  message?: string;
};

/**
 * Global settings store:
 * - Pull once on app load (when logged in) via `pullLatest()`
 * - Push only on local admin changes via `updateSettings()`
 *
 * This is intentionally lightweight for a starter template.
 */
export const useGlobalSettingsStore = defineStore(
  'globalSettings',
  () => {
    const settings = ref<GlobalSettings>(getDefaultSettings());
    const updatedAt = ref<Date>(new Date(0));

    /**
     * Metadata provider capabilities returned by the server.
     * This deliberately contains NO secrets; it's safe to persist client-side.
     */
    const capabilities = ref<{ hardcoverAvailable: boolean }>({
      hardcoverAvailable: false,
    });

    /**
     * Apply settings coming from the server WITHOUT triggering a push.
     * This avoids “pull triggers push” loops.
     */
    function applyRemoteSettings(remote: unknown, remoteUpdatedAt?: unknown) {
      settings.value = {
        ...getDefaultSettings(),
        ...(remote as Partial<GlobalSettings>),
      };

      const d =
        remoteUpdatedAt instanceof Date
          ? remoteUpdatedAt
          : typeof remoteUpdatedAt === 'string' ||
              typeof remoteUpdatedAt === 'number'
            ? new Date(remoteUpdatedAt)
            : new Date();
      updatedAt.value = Number.isNaN(d.getTime()) ? new Date() : d;
    }

    /**
     * Pull the latest global settings (requires being logged in).
     * Safe to call multiple times; it just overwrites local cache with server state.
     */
    async function pullLatest() {
      const { session } = useAuth();
      if (!session.value) return;

      const res = await $fetch<GlobalSettingsApiGetResponse>('/api/settings', {
        method: 'GET',
      });

      if (!res?.success) return;

      // Capabilities (safe, non-secret flags from server)
      capabilities.value = {
        hardcoverAvailable: !!res.data?.capabilities?.hardcoverAvailable,
      };

      const remote = res.data?.globalSettings;
      if (!remote) return;

      applyRemoteSettings(remote.settings, remote.updatedAt);
    }

    /**
     * Update settings locally and push them to the server.
     * The server enforces admin/owner; non-admin calls will get 403.
     */
    async function updateSettings(updated: Partial<GlobalSettings>) {
      if (Object.keys(updated).length === 0) return;

      settings.value = { ...settings.value, ...updated };
      updatedAt.value = new Date();

      // Convenience: avoid pushing if not admin on the client (server still enforces)
      const { isAdmin } = useAuth();
      if (!isAdmin.value) return;

      await $fetch<GlobalSettingsApiPutResponse>('/api/settings/global', {
        method: 'PUT',
        body: {
          settings: settings.value,
        },
      });
    }

    function $reset() {
      settings.value = getDefaultSettings();
      updatedAt.value = new Date(0);
    }

    return {
      settings,
      updatedAt,
      capabilities,
      applyRemoteSettings,
      pullLatest,
      updateSettings,
      $reset,
    };
  },
  {
    persist: true,
  },
);
