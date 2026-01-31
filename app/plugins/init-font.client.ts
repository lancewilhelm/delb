export default defineNuxtPlugin(() => {
  const userSettings = useUserSettingsStore();
  watch(
    () => userSettings.activeSettings.fontFamily,
    (family) => {
      useHead({
        style: [
          {
            innerHTML: `
              body, html {
                font-family: ${family || 'Geist, sans-serif'} !important;
              }
            `,
            id: 'currentFontFamilyStyle',
          },
        ],
      });
    },
    { immediate: true },
  );
});
