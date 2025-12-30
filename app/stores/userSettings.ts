import { defineStore } from "pinia";

export const fontFamilyOptions = [
  "Fira Code",
  "Geist",
  "IBM Plex Mono",
  "Inter",
  "Montserrat",
  "Nunito",
  "Poppins",
  "Roboto Mono",
] as const;
export type FontFamily = (typeof fontFamilyOptions)[number];

export const funboxModes = ["confetti", "snow"];
export type FunboxMode = (typeof funboxModes)[number];

export interface UserSettings {
  theme?: string;
  fontFamily: FontFamily;
  favoriteThemes: string[];
  themeSorting: {
    sortedByName: boolean;
    reverseSort: boolean;
  };
  funboxModes: FunboxMode[];
}

function getDefaultSettings(): UserSettings {
  return {
    fontFamily: "Geist",
    favoriteThemes: [],
    themeSorting: {
      sortedByName: false,
      reverseSort: false,
    },
    funboxModes: [],
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

export const useUserSettingsStore = defineStore(
  "userSettings",
  () => {
    const settings = ref<UserSettings>(getDefaultSettings());

    /**
     * Push the full user settings blob to the server.
     * Keep this intentionally lightweight; server stores JSON.
     */
    async function push() {
      const { session } = useAuth();
      if (!session.value) return;

      await $fetch("/api/settings/user", {
        method: "PUT",
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

      const res = await $fetch<SettingsApiGetResponse>("/api/settings", {
        method: "GET",
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

      settings.value = { ...settings.value, ...remote };
      updatedAt.value = remoteUpdatedAt
        ? new Date(remoteUpdatedAt)
        : new Date();
      synced.value = true;
    }

    /**
     * Local user intent update: optimistic update + push to server.
     */
    async function updateSettings(updated: Partial<UserSettings>) {
      if (!updated || Object.keys(updated).length === 0) return;

      settings.value = { ...settings.value, ...updated };
      updatedAt.value = new Date();
      synced.value = false;

      try {
        await push();
      } catch (err) {
        // Keep unsynced so a later pull/push can reconcile.
        console.error("Failed to push user settings:", err);
      }
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
      updatedAt,
      synced,
      updateSettings,
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
