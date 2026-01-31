import { defineNuxtPlugin } from '#app';
import tooltip from '~/directives/tooltip';

/**
 * Register the `v-tooltip` directive during SSR as well.
 *
 * Even though the directive is DOM-driven and will no-op in non-browser
 * environments, it still needs to be registered on the server so Vue SSR can
 * resolve it and avoid `Failed to resolve directive: tooltip` and related
 * `getSSRProps` errors.
 */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive('tooltip', tooltip);
});
