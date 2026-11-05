<script setup lang="ts">
import { readingStatusDetails } from '~/utils/bookReadingStatus';

const props = defineProps<{ status?: string | null }>();
const settings = useUserSettingsStore();
const details = computed(() => readingStatusDetails(props.status));
</script>

<template>
  <span
    v-if="settings.activeSettings.coverStyle.showReadingStatus && details"
    role="img"
    :aria-label="`Reading status: ${details.label}`"
    :title="details.label"
    class="absolute top-1 right-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-(--main-color)/40 bg-(--bg-color) text-(--main-color) pointer-events-none"
  >
    <Icon :name="details.icon" class="text-xs" aria-hidden="true" />
  </span>
</template>
