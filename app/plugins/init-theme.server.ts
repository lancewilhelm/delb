import { customThemeCss } from '~/utils/customTheme';
import { resolveTheme } from '~/utils/themePreference';

export default defineNuxtPlugin(() => {
  const settings = useUserSettingsStore().activeSettings;
  const preference = settings.themePreference;
  const variants =
    preference.mode === 'system'
      ? [
          {
            theme: resolveTheme(preference, false),
            media: '(prefers-color-scheme: light)',
            id: 'systemThemeLight',
          },
          {
            theme: resolveTheme(preference, true),
            media: '(prefers-color-scheme: dark)',
            id: 'systemThemeDark',
          },
        ]
      : [
          {
            theme: resolveTheme(preference, false),
            media: undefined,
            id: 'currentTheme',
          },
        ];
  useHead({
    style: variants
      .filter(({ theme }) => theme === 'custom')
      .map(({ id, media }) => ({
        id,
        media,
        textContent: customThemeCss(settings.customTheme),
      })),
    link: variants
      .filter(({ theme }) => theme !== 'custom')
      .map(({ id, media, theme }) => ({
        id,
        media,
        rel: 'stylesheet',
        href: `/css/themes/${theme}.css`,
      })),
  });
});
