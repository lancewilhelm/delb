import themes from '~/assets/json/themes.json';
import {
  appearanceContrastTarget,
  appearanceContrastVariables,
} from '~/utils/appearanceContrast';
import { defaultCustomTheme, normalizeCustomTheme } from '~/utils/customTheme';
import { resolveTheme } from '~/utils/themePreference';

export default defineNuxtPlugin(() => {
  const store = useUserSettingsStore();
  const appearance = useThemeAppearance();

  function targetRule(theme: string) {
    const palette =
      theme === 'custom'
        ? normalizeCustomTheme(store.activeSettings.customTheme)
        : (themes.find(({ name }) => name === theme) ?? defaultCustomTheme);
    return `:root{--appearance-contrast-target:${appearanceContrastTarget(palette.bgColor)};--appearance-contrast-inverse-target:${appearanceContrastTarget(palette.mainColor)};--appearance-contrast-error-inverse-target:${appearanceContrastTarget(palette.errorColor)}}`;
  }

  useHead(() => {
    const settings = store.activeSettings;
    const preference = settings.themePreference;
    const preview = appearance.preview.value;
    const targetCss =
      preview !== null
        ? targetRule(preview)
        : preference.mode === 'system'
          ? `${targetRule(resolveTheme(preference, false))}@media(prefers-color-scheme:dark){${targetRule(resolveTheme(preference, true))}}`
          : targetRule(resolveTheme(preference, false));
    return {
      htmlAttrs: {
        style: appearanceContrastVariables(settings.appearanceContrast),
      },
      style: [{ id: 'appearanceContrastTarget', textContent: targetCss }],
    };
  });
});
