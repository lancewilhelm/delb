import { computed, ref } from 'vue';
import { useUserSettingsStore } from '~/stores/userSettings';
import { resolveTheme } from '~/utils/themePreference';

const systemDarkState = ref(false);
const themePreviewState = ref<string | null>(null);

export function useThemeAppearance() {
  const store = useUserSettingsStore();
  const dark = systemDarkState;
  const preview = themePreviewState;
  const resolved = computed(() =>
    resolveTheme(store.activeSettings.themePreference, dark.value),
  );

  function selectFixed(theme: string) {
    preview.value = null;
    void store.updateSettings({
      themePreference: {
        ...store.activeSettings.themePreference,
        mode: 'fixed',
        fixed: theme,
      },
    });
  }
  function assignSlot(slot: 'light' | 'dark', theme: string) {
    preview.value = null;
    void store.updateSettings({
      themePreference: {
        ...store.activeSettings.themePreference,
        mode: 'system',
        [slot]: theme,
      },
    });
  }
  function useSystem() {
    preview.value = null;
    void store.updateSettings({
      themePreference: {
        ...store.activeSettings.themePreference,
        mode: 'system',
      },
    });
  }
  return { dark, preview, resolved, selectFixed, assignSlot, useSystem };
}
