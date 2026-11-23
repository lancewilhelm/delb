import { watch } from 'vue';
import { useHead } from '~/composables/useHead';
import { useUserSettingsStore } from '~/stores/userSettings';

export function initFont() {
  const userSettings = useUserSettingsStore();
  watch(
    () => userSettings.activeSettings.fontFamily,
    (family) => {
      useHead({
        style: [
          {
            innerHTML: `
              body, html {
                font-family: ${family || 'Nunito, sans-serif'} !important;
              }
            `,
            id: 'currentFontFamilyStyle',
          },
        ],
      });
    },
    { immediate: true },
  );
}
