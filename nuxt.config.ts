import tailwindcss from '@tailwindcss/vite';

export default defineNuxtConfig({
  ssr: true,
  compatibilityDate: '2025-04-12',
  devtools: { enabled: false },
  modules: [
    '@nuxt/eslint',
    '@nuxt/fonts',
    '@nuxt/icon',
    '@vueuse/nuxt',
    '@pinia/nuxt',
    'pinia-plugin-persistedstate/nuxt',
  ],
  app: {
    head: {
      htmlAttrs: {
        lang: 'en',
      },
      meta: [
        { name: 'theme-color', content: '#1b1b1b' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        {
          name: 'apple-mobile-web-app-status-bar-style',
          content: 'black-translucent',
        },
        { name: 'apple-mobile-web-app-title', content: 'Delb' },
        { name: 'msapplication-TileColor', content: '#1b1b1b' },
      ],
      link: [
        {
          rel: 'icon',
          id: 'fallback-favicon',
          type: 'image/svg+xml',
          href: '/favicon.svg',
        },
        {
          rel: 'apple-touch-icon',
          sizes: '180x180',
          href: '/apple-touch-icon.png',
        },
        { rel: 'mask-icon', href: '/safari-pinned-tab.svg', color: '#1b1b1b' },
      ],
    },
  },
  css: ['~/assets/css/main.css'],
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
