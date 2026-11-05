<script setup lang="ts">
defineProps<{
  isActiveTab: boolean;
  path: string;
  icon: string;
  label: string;
}>();
</script>

<template>
  <NuxtLink
    :to="path"
    :class="[
      'flex items-center gap-1 cursor-pointer hover:opacity-80 settings-tab-bar-item',
      isActiveTab ? 'text-(--contrast-main-color) underline' : 'text-(--contrast-text-color)',
    ]"
  >
    <Icon :name="icon" class="text-(--contrast-main-color) header-icon" />
    {{ label }}
  </NuxtLink>
</template>
