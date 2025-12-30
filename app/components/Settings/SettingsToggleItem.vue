<script setup lang="ts">
defineProps<{
  value: boolean;
  title?: string;
  description?: string;
  trueLabel?: string;
  falseLabel?: string;
}>();

const emit = defineEmits(["toggle"]);
</script>

<template>
  <div
    class="w-full grid grid-cols-[1fr_min-content] grid-rows-2 items-center gap-2"
  >
    <div v-if="title" class="row-start-1 col-start-1">{{ title }}</div>
    <div v-if="description" class="row-start-2 col-start-1 italic">
      {{ description }}
    </div>
    <button
      :class="[
        'flex col-start-2 row-span-2 w-[60px] border-2! border-(--sub-alt-color)! bg-(--bg-color)! rounded-full! p-0!',
        value ? 'justify-end! bg-(--main-color)!' : 'justify-start!',
      ]"
      @click.stop="emit('toggle')"
    >
      <div
        :class="[
          'w-[30px] h-[30px] border-4 rounded-full',
          value
            ? ' bg-(--bg-color) border-(--main-color)'
            : 'bg-(--main-color) border-(--bg-color)',
        ]"
      />
    </button>
    <div class="row-span-2 italic justify-self-end">
      <div v-if="value" class="text-sm">
        {{ trueLabel }}
      </div>
      <div v-else class="text-sm">
        {{ falseLabel }}
      </div>
    </div>
  </div>
</template>
