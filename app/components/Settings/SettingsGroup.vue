<script setup lang="ts">
defineProps<{
  title: string;
  icon: string | Component;
  description?: string;
}>();
</script>
<template>
  <div class="flex flex-col items-start w-full mb-5 settings-group">
    <div
      class="flex w-full items-center justify-between gap-3 text-(--main-color) text-xl settings-group-header"
    >
      <div class="flex items-center gap-1 settings-group-title text-nowrap">
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
        class="justify-self-end text-right text-(--sub-color) text-sm settings-group-description"
      >
        {{ description }}
      </div>
    </div>
    <div class="w-full h-[1px] bg-(--sub-color) my-2 header-line" />
    <slot />
  </div>
</template>
