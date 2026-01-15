export default defineNuxtPlugin(() => {
  const userSettings = useUserSettingsStore();
  watch(
    () => userSettings.activeSettings.theme,
    (theme) => {
      if (!theme) return;
      loadTheme(theme);
    },
    { immediate: true },
  );
});
