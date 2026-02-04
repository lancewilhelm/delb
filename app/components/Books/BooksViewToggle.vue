<script setup lang="ts">
defineOptions({ name: 'BooksViewToggle' });

const uiStore = useUiStore();
const { booksViewMode } = storeToRefs(uiStore);
const hydrated = ref(false);

onMounted(() => {
  hydrated.value = true;
});

const effectiveMode = computed(() =>
  hydrated.value ? booksViewMode.value : 'grid',
);

function setMode(mode: 'grid' | 'list') {
  if (booksViewMode.value === mode) return;
  uiStore.setBooksViewMode(mode);
}
</script>

<template>
  <div
    class="flex items-center gap-1 border-(--sub-color) rounded-md p-0.5 bg-(--bg-color)"
    role="group"
    aria-label="Books view mode"
  >
    <button
      v-tooltip="'Grid View'"
      type="button"
      class="flex items-center gap-1 px-2 py-1 rounded text-sm transition"
      :class="
        effectiveMode === 'grid'
          ? 'bg-(--sub-color)/25 text-(--main-color)'
          : 'text-(--text-color) opacity-70 hover:opacity-100'
      "
      :aria-pressed="effectiveMode === 'grid' ? 'true' : 'false'"
      @click="setMode('grid')"
    >
      <Icon name="lucide:layout-grid" class="text-base" />
      <!-- <span class="hidden sm:inline">Grid</span> -->
    </button>

    <button
      v-tooltip="'List View'"
      type="button"
      class="flex items-center gap-1 px-2 py-1 rounded text-sm transition"
      :class="
        effectiveMode === 'list'
          ? 'bg-(--sub-color)/25 text-(--main-color)'
          : 'text-(--text-color) opacity-70 hover:opacity-100'
      "
      :aria-pressed="effectiveMode === 'list' ? 'true' : 'false'"
      @click="setMode('list')"
    >
      <Icon name="lucide:list" class="text-base" />
      <!-- <span class="hidden sm:inline">List</span> -->
    </button>
  </div>
</template>
