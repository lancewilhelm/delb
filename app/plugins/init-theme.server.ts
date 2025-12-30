export default defineNuxtPlugin(() => {
  if (import.meta.client) return;
  const route = useRoute();
  const isLoggedIn = route.path !== "/login" && route.path !== "/register";

  const userSettings = useUserSettingsStore(); // SSR-compatible

  const theme =
    userSettings.settings.theme && isLoggedIn
      ? userSettings.settings.theme
      : "guage";

  useHead({
    link: [
      {
        id: "currentTheme",
        rel: "stylesheet",
        href: `/css/themes/${theme}.css`,
      },
    ],
  });
});
