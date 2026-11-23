import type AppIcon from '~/components/AppIcon.vue';

declare module 'vue' {
  export interface GlobalComponents {
    Icon: typeof AppIcon;
  }
}

export {};
