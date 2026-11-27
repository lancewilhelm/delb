<script setup lang="ts">
import { watch } from 'vue';
import { RouterView } from 'vue-router';
import CommandPalette from '~/components/CommandPalette/CommandPalette.vue';
import GlobalSearchModal from '~/components/GlobalSearch/GlobalSearchModal.vue';
import MiniCoverModal from '~/components/MiniCover/MiniCoverModal.vue';
import ShareCardModal from '~/components/ShareCard/ShareCardModal.vue';
import ShareCardToast from '~/components/ShareCard/ShareCardToast.vue';
import { useDynamicFavicon } from '~/composables/useDynamicFavicon';
import { useHead } from '~/composables/useHead';

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
    <RouterView v-slot="{ Component, route }">
      <component
        :is="Component"
        :key="route.meta.keyByFullPath ? route.fullPath : undefined"
      />
    </RouterView>
    <CommandPalette />
    <GlobalSearchModal />
    <ShareCardModal />
    <MiniCoverModal />
    <ShareCardToast />
  </div>
</template>
