export default defineNuxtPlugin(() => {
  const settings = useUserSettingsStore();
  useHead(() => ({
    htmlAttrs: {
      style: {
        '--glass-opacity': `${settings.activeSettings.glassOpacity}%`,
        '--glass-blur':
          settings.activeSettings.glassOpacity === 100 ? '0px' : '12px',
      },
    },
  }));
});
