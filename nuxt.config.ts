import tailwindcss from '@tailwindcss/vite';

export default defineNuxtConfig({
  future: {
    compatibilityVersion: 4,
  },
  ssr: true,
  compatibilityDate: '2025-04-12',
  devtools: { enabled: false },
  modules: [
    '@nuxt/eslint',
    '@nuxt/fonts',
    '@nuxt/icon',
    '@vueuse/nuxt',
    '@pinia/nuxt',
    '@nuxtjs/mdc',
    'pinia-plugin-persistedstate/nuxt',
  ],
  app: {
    head: {
      htmlAttrs: {
        lang: 'en',
      },
      link: [
        {
          rel: 'icon',
          id: 'fallback-favicon',
          type: 'image/svg+xml',
          href: '/favicon.svg',
        },
      ],
    },
  },
  css: ['~/assets/css/main.css', '~/assets/css/hljs.css'],
  runtimeConfig: {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    public: {
      debug: false,
      appVersion: '',
    },
  },
  imports: {
    dirs: ['utils'],
  },
  vite: {
    plugins: [tailwindcss()],
  },
  icon: {
    customCollections: [
      {
        prefix: 'local',
        dir: './app/assets/icons',
      },
    ],
    clientBundle: {
      scan: true,
    },
  },
  fonts: {
    families: [
      { name: 'Fira Code', provider: 'google', global: true },
      { name: 'Geist', provider: 'google', global: true },
      { name: 'IBM Plex Mono', provider: 'google', global: true },
      { name: 'Inter', provider: 'google', global: true },
      { name: 'Montserrat', provider: 'google', global: true },
      { name: 'Nunito', provider: 'google', global: true },
      { name: 'Poppins', provider: 'google', weight: 'bold', global: true },
      { name: 'Roboto Mono', provider: 'google', global: true },
    ],
  },
  piniaPluginPersistedstate: {
    key: 'delb.%id',
    storage: 'localStorage',
  },
  nitro: {
    experimental: {
      asyncContext: true,
    },
  },
});
