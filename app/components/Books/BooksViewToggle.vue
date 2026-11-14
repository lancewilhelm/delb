<script setup lang="ts">
defineOptions({ name: 'BooksViewToggle' });

const props = withDefaults(
  defineProps<{ showBookshelf?: boolean; bookshelf?: boolean }>(),
  { showBookshelf: false, bookshelf: false },
);
const emit = defineEmits<{ bookshelf: [value: boolean] }>();
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
  if (props.bookshelf) emit('bookshelf', false);
  if (booksViewMode.value === mode) return;
  uiStore.setBooksViewMode(mode);
}
</script>

<template>
  <div
    class="flex items-center gap-1 border-(--contrast-border-color) rounded-md p-0.5 bg-(--bg-color)"
    role="group"
    aria-label="Books view mode"
  >
    <button
      v-tooltip="'Grid View'"
      aria-label="Grid View"
      type="button"
      class="flex items-center gap-1 px-2 py-1 rounded text-sm transition text-(--contrast-main-color)"
      :class="
        effectiveMode === 'grid' && !bookshelf
          ? 'bg-(--sub-color)/25'
          : 'opacity-70 hover:opacity-100'
      "
      :aria-pressed="effectiveMode === 'grid' && !bookshelf ? 'true' : 'false'"
      @click="setMode('grid')"
    >
      <Icon name="lucide:layout-grid" class="text-base" />
      <!-- <span class="hidden sm:inline">Grid</span> -->
    </button>

    <button
      v-tooltip="'List View'"
      aria-label="List View"
      type="button"
      class="flex items-center gap-1 px-2 py-1 rounded text-sm transition text-(--contrast-main-color)"
      :class="
        effectiveMode === 'list' && !bookshelf
          ? 'bg-(--sub-color)/25'
          : 'opacity-70 hover:opacity-100'
      "
      :aria-pressed="effectiveMode === 'list' && !bookshelf ? 'true' : 'false'"
      @click="setMode('list')"
    >
      <Icon name="lucide:list" class="text-base" />
      <!-- <span class="hidden sm:inline">List</span> -->
    </button>
    <button
      v-if="showBookshelf"
      v-tooltip="'Bookshelf View'"
      aria-label="Bookshelf View"
      type="button"
      class="flex items-center gap-1 px-2 py-1 rounded text-sm transition text-(--contrast-main-color)"
      :class="
        bookshelf ? 'bg-(--sub-color)/25' : 'opacity-70 hover:opacity-100'
      "
      :aria-pressed="bookshelf"
      @click="emit('bookshelf', true)"
    >
      <Icon name="lucide:library-big" class="text-base" />
    </button>
    <BooksViewSettings v-if="!bookshelf" :mode="effectiveMode" />
  </div>
</template>
