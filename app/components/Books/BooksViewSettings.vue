<script setup lang="ts">
import type { BookViewMode } from '~/utils/bookFields';
defineProps<{ mode: BookViewMode }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
onClickOutside(root, () => {
  open.value = false;
});
async function toggle() {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    panel.value?.querySelector<HTMLInputElement>('input')?.focus();
  }
}
function close() {
  open.value = false;
  trigger.value?.focus();
}
</script>

<template>
  <div ref="root" class="relative" @keydown.esc.stop="close">
    <button
      ref="trigger"
      type="button"
      class="flex items-center px-2 py-1 text-(--contrast-main-color)"
      :aria-label="`${mode === 'grid' ? 'Grid' : 'List'} view settings`"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="toggle"
    >
      <Icon name="lucide:sliders-horizontal" />
    </button>
    <div
      v-if="open"
      ref="panel"
      role="dialog"
      :aria-label="`${mode === 'grid' ? 'Grid' : 'List'} view settings`"
      class="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto border border-(--contrast-border-color) bg-(--bg-color) rounded-md shadow-lg z-50 p-3"
    >
      <div class="flex items-center justify-between mb-2">
        <div class="text-sm font-semibold">
          {{ mode === 'grid' ? 'Grid' : 'List' }} view settings
        </div>
        <button type="button" aria-label="Close view settings" @click="close">
          <Icon name="lucide:x" />
        </button>
      </div>
      <BooksViewFieldsSettings :key="mode" :mode="mode" />
    </div>
  </div>
</template>
