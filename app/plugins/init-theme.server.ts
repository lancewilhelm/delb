export default defineNuxtPlugin(() => {
  if (import.meta.client) return;
  const route = useRoute();
  const isLoggedIn = route.path !== '/login' && route.path !== '/register';

  const userSettings = useUserSettingsStore(); // SSR-compatible

  const theme =
    userSettings.activeSettings.theme && isLoggedIn
      ? userSettings.activeSettings.theme
      : 'guage';

  useHead({
    link: [
      {
        id: 'currentTheme',
        rel: 'stylesheet',
        href: `/css/themes/${theme}.css`,
      },
    ],
  });
});
