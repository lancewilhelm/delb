/// <reference types="vite/client" />

declare const __DELB_APP_VERSION__: string;

declare module 'virtual:delb-icons' {
  import type { IconifyJSON } from '@iconify/vue';
  export const lucideCollection: IconifyJSON;
}
