import '~/assets/css/main.css';
import '~/utils/fonts';

import { createPinia } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';
import { createApp } from 'vue';
import App from '~/app.vue';
import AppIcon from '~/components/AppIcon.vue';
import { useAuth } from '~/composables/useAuth';
import tooltip from '~/directives/tooltip';
import { initContrast } from '~/plugins/init-contrast';
import { initFont } from '~/plugins/init-font';
import { initSync } from '~/plugins/init-sync';
import { initTheme } from '~/plugins/init-theme';
import { createAppRouter } from '~/router';
import { registerIcons } from '~/utils/icons';
import { setAppRouter } from '~/utils/navigation';

async function bootstrap() {
  registerIcons();

  const app = createApp(App);

  const pinia = createPinia();
  pinia.use(
    createPersistedState({
      key: (id) => `delb.${id}`,
      storage: localStorage,
    }),
  );
  app.use(pinia);

  app.directive('tooltip', tooltip);
  app.component('Icon', AppIcon);

  const router = createAppRouter();
  setAppRouter(router);

  initContrast();
  initFont();

  // Resolve the auth session BEFORE installing the router (`app.use(router)`
  // triggers the initial navigation immediately). Otherwise `router.beforeEach`
  // can race with `fetchSession()`, see `loggedIn === false`, redirect to
  // `/login`, and then bounce back to `/` once the session finishes loading.
  await useAuth().fetchSession();
  const pullSettingsAfterMount = initSync();

  app.use(router);
  await router.isReady();
  app.mount('#app');

  initTheme();
  void pullSettingsAfterMount();
}

void bootstrap();
