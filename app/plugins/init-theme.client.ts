export default defineNuxtPlugin(() => {
  const userSettings = useUserSettingsStore();
  const appearance = useThemeAppearance();
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  appearance.dark.value = media.matches;
  media.addEventListener('change', (event) => {
    appearance.dark.value = event.matches;
  });
  watch(
    () =>
      [
        appearance.preview.value ?? appearance.resolved.value,
        userSettings.activeSettings.customTheme,
      ] as const,
    ([theme, palette]) => {
      void loadTheme(theme, palette).catch((error) =>
        console.error('Failed to apply theme:', error),
      );
    },
    { immediate: true, deep: true, flush: 'sync' },
  );
});
