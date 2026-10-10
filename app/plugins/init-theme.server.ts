import { customThemeCss } from '~/utils/customTheme';

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
    style:
      theme === 'custom'
        ? [
            {
              id: 'currentTheme',
              textContent: customThemeCss(
                userSettings.activeSettings.customTheme,
              ),
            },
          ]
        : [],
    link:
      theme === 'custom'
        ? []
        : [
            {
              id: 'currentTheme',
              rel: 'stylesheet',
              href: `/css/themes/${theme}.css`,
            },
          ],
  });
});
