export default defineNuxtPlugin(() => {
  if (import.meta.client) return; // SSR only
  const route = useRoute();
  const isLoggedIn = route.path !== "/login" && route.path !== "/register";
  const userSettings = useUserSettingsStore(); // SSR-compatible

  // Use user's setting or fallback
  const fontFamily =
    userSettings.settings.fontFamily && isLoggedIn
      ? userSettings.settings.fontFamily
      : "Geist, sans-serif";

  useHead({
    style: [
      {
        innerHTML: `
        body, html {
          font-family: ${fontFamily} !important;
        }
      `,
        id: "currentFontFamilyStyle",
      },
    ],
  });
});
