<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string | null;
  coverSrc?: string | null;
}>();
</script>
<template>
  <div class="flex items-center gap-2 min-w-0 w-full h-full">
    <BookCover
      class="w-auto! h-full! aspect-2/3! shrink-0"
      :src="coverSrc"
      :title="title"
      :alt="`Cover for ${title}`"
    />
    <div class="flex flex-col min-w-0 flex-1">
      <div class="truncate">{{ title }}</div>
      <div v-if="subtitle" class="text-xs opacity-70 truncate">
        {{ subtitle }}
      </div>
    </div>
    <slot />
  </div>
</template>
