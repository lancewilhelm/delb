<script setup lang="ts">
import { Icon as IconifyIcon } from '@iconify/vue';

defineProps<{
  name: string;
}>();
</script>

<template>
  <IconifyIcon :icon="name" class="inline-block align-middle shrink-0" />
</template>
