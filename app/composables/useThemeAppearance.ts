import { resolveTheme } from '~/utils/themePreference';

export function useThemeAppearance() {
  const store = useUserSettingsStore();
  const dark = useState('theme-system-dark', () => false);
  const preview = useState<string | null>('theme-preview', () => null);
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
