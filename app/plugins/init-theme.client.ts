export default defineNuxtPlugin(() => {
  const userSettings = useUserSettingsStore();
  watch(
    () => userSettings.settings.theme,
    (theme) => {
      if (!theme) return;
      loadTheme(theme);
    },
    { immediate: true },
  );
});
