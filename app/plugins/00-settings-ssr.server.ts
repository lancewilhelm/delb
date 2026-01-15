import type { UserSettings } from '~/stores/userSettings';

type SettingsApiGetResponse = {
  success: boolean;
  data?: {
    userSettings?: {
      settings: unknown;
      updatedAt: string | number | Date;
    } | null;
    globalSettings?: {
      settings: unknown;
      updatedAt: string | number | Date;
    } | null;
    capabilities?: {
      hardcoverAvailable?: boolean;
    };
  };
};

export default defineNuxtPlugin(async () => {
  if (import.meta.client) return;

  const headers = useRequestHeaders(['cookie']);
  const baseURL = useRequestURL().origin;

  const userSettingsStore = useUserSettingsStore();
  const globalSettingsStore = useGlobalSettingsStore();

  try {
    const res = await $fetch<SettingsApiGetResponse>('/api/settings', {
      method: 'GET',
      baseURL,
      headers,
    });

    if (!res?.success || !res.data) return;

    const userSettings = res.data.userSettings;
    if (userSettings?.settings) {
      userSettingsStore.applyRemoteSettings(
        userSettings.settings as Partial<UserSettings>,
        userSettings.updatedAt,
      );
    }

    const globalSettings = res.data.globalSettings;
    if (globalSettings?.settings) {
      globalSettingsStore.applyRemoteSettings(
        globalSettings.settings,
        globalSettings.updatedAt,
      );
    }

    if (res.data.capabilities) {
      globalSettingsStore.capabilities = {
        hardcoverAvailable: !!res.data.capabilities.hardcoverAvailable,
      };
    }
  } catch (error) {
    console.error('SSR settings preload failed:', error);
  }
});
