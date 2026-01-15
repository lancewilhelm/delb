<script setup lang="ts">
defineProps<{
  title: string;
  icon?: string | Component;
  description?: string;
}>();
</script>
<template>
  <div class="flex flex-col items-start w-full mb-4 settings-sub-group">
    <div
      class="flex w-full items-center justify-between gap-1 text-(--main-color) text-xl settings-sub-group-header"
    >
      <div
        class="flex gap-1 items-center text-(--main-color) text-lg border-b border-(--sub-color) mb-4 p-2 settings-sub-group-title"
      >
        <Icon
          v-if="typeof icon === 'string'"
          :name="icon"
          class="text-(--main-color) shrink-0"
        />
        <component
          :is="icon"
          v-else
          class="text-(--main-color) fill-(--main-color)"
        />
        {{ title }}
      </div>
      <div
        class="justify-self-end text-(--sub-color) text-sm settings-sub-group-description"
      >
        {{ description }}
      </div>
    </div>
    <slot />
  </div>
</template>
