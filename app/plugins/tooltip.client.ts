import { defineNuxtPlugin } from "#app";
import tooltip from "~/directives/tooltip";

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive("tooltip", tooltip);
});
