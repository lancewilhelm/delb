<script setup lang="ts">
const uiStore = useUiStore();
type BooksSortOption = {
  id: 'dateAdded' | 'alphabetical' | 'publishedDate' | 'pages';
  label: string;
};

const booksSortOptions: BooksSortOption[] = [
  { id: 'dateAdded', label: 'Date added' },
  { id: 'alphabetical', label: 'Alphabetical' },
  { id: 'publishedDate', label: 'Published date' },
  { id: 'pages', label: 'Pages' },
];

const sortOpen = ref(false);
const sortAnchorRef = ref<HTMLElement | null>(null);
const sortPanelRef = ref<HTMLElement | null>(null);

const activeBooksSortLabel = computed(() => {
  return (
    booksSortOptions.find((o) => o.id === uiStore.booksSortKey)?.label ??
    'Date added'
  );
});

function closeSortDropdown() {
  sortOpen.value = false;
}

function toggleSortDropdown() {
  sortOpen.value = !sortOpen.value;
}

function selectBooksSort(sortId: BooksSortOption['id']) {
  if (uiStore.booksSortKey === sortId) {
    uiStore.toggleBooksSortDirection();
  } else {
    uiStore.setBooksSortKey(sortId);
  }
  closeSortDropdown();
}

function onSortDocumentPointerDown(e: MouseEvent) {
  if (!sortOpen.value) return;
  const target = e.target as Node | null;

  if (
    (sortPanelRef.value && target && sortPanelRef.value.contains(target)) ||
    (sortAnchorRef.value && target && sortAnchorRef.value.contains(target))
  ) {
    return;
  }

  closeSortDropdown();
}

function onSortDocumentKeyDown(e: KeyboardEvent) {
  if (!sortOpen.value) return;
  if (e.key === 'Escape') closeSortDropdown();
}

onMounted(() => {
  document.addEventListener('mousedown', onSortDocumentPointerDown);
  document.addEventListener('keydown', onSortDocumentKeyDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onSortDocumentPointerDown);
  document.removeEventListener('keydown', onSortDocumentKeyDown);
});
</script>

<template>
  <div class="relative">
    <button
      ref="sortAnchorRef"
      class="p-1 flex items-center gap-2"
      aria-label="Sort books"
      :aria-expanded="sortOpen"
      aria-haspopup="menu"
      @click="toggleSortDropdown"
    >
      <Icon
        name="lucide:arrow-up-down"
        class="text-(--main-color) opacity-80 shrink-0 text-xl sm:text-lg"
      />
      <span class="hidden lg:block text-sm opacity-80">{{
        activeBooksSortLabel
      }}</span>
    </button>

    <div
      v-if="sortOpen"
      ref="sortPanelRef"
      class="absolute right-0 mt-1 w-48 border border-(--sub-color) bg-(--bg-color) rounded-md shadow-lg z-50 overflow-hidden"
      role="menu"
    >
      <div class="px-2 py-1 border-b border-(--sub-color)">
        <div class="text-xs opacity-70">Sort</div>
      </div>

      <div>
        <button
          v-for="o in booksSortOptions"
          :key="o.id"
          class="w-full px-3 py-2 text-left flex justify-between! gap-3 rounded-none!"
          :class="
            uiStore.booksSortKey === o.id
              ? 'bg-(--sub-color)/20'
              : 'hover:bg-(--sub-color)/15'
          "
          role="menuitem"
          @click="selectBooksSort(o.id)"
        >
          <span class="truncate text-sm">{{ o.label }}</span>
          <Icon
            v-if="uiStore.booksSortKey === o.id"
            :name="
              uiStore.booksSortDirection === 'asc'
                ? 'lucide:arrow-up'
                : 'lucide:arrow-down'
            "
            class="text-(--main-color) opacity-80 shrink-0"
          />
        </button>
      </div>
    </div>
  </div>
</template>
