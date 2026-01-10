<script setup lang="ts">
import { useDynamicFavicon } from '@/composables/useDynamicFavicon';

const favicon = useDynamicFavicon();

// Reactive title
useHead({
  titleTemplate: (title: string | undefined) =>
    title ? `${title} | Delb` : 'Delb',
});

// Favicon updater: watch and re-apply the head link
watch(
  favicon,
  (newFavicon) => {
    useHead({
      link: [
        {
          rel: 'icon',
          id: 'favicon',
          type: 'image/svg+xml',
          href: newFavicon,
        },
      ],
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="w-dvw h-dvh overflow-hidden">
    <NuxtPage />
    <CommandPalette />
    <GlobalSearchModal />
  </div>
</template>
