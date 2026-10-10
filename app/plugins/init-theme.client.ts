export default defineNuxtPlugin(() => {
  const userSettings = useUserSettingsStore();
  watch(
    () =>
      [
        userSettings.activeSettings.theme,
        userSettings.activeSettings.customTheme,
      ] as const,
    ([theme, palette]) => {
      if (!theme) return;
      void loadTheme(theme, palette).catch((error) =>
        console.error('Failed to apply theme:', error),
      );
    },
    { immediate: true, deep: true },
  );
});
