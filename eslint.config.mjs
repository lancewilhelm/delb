// @ts-check
import withNuxt from "./.nuxt/eslint.config.mjs";

export default withNuxt([
  {
    rules: {
      "vue/html-self-closing": "off", // Allow any style of self-closing tags
    },
  },
]);
// Your custom configs here
