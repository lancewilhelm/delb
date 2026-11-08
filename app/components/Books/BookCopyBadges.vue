<script setup lang="ts">
defineProps<{ physical?: boolean; audiobook?: boolean }>();
const settings = useUserSettingsStore();
</script>

<template>
  <span
    v-if="
      settings.activeSettings.coverStyle.showCopyIndicators &&
      (physical || audiobook)
    "
    class="absolute bottom-1 right-1 z-10 flex gap-0.5 pointer-events-none"
  >
    <span
      v-if="physical"
      role="img"
      aria-label="Physical copy"
      title="Physical copy"
      class="flex h-5 w-5 items-center justify-center rounded-full border border-(--main-color)/40 bg-(--bg-color) text-(--main-color)"
      ><Icon name="lucide:book" class="text-xs" aria-hidden="true"
    /></span>
    <span
      v-if="audiobook"
      role="img"
      aria-label="Audiobook copy"
      title="Audiobook copy"
      class="flex h-5 w-5 items-center justify-center rounded-full border border-(--main-color)/40 bg-(--bg-color) text-(--main-color)"
      ><Icon name="lucide:headphones" class="text-xs" aria-hidden="true"
    /></span>
  </span>
</template>
