<script setup lang="ts">
defineOptions({ name: 'ViewSelectorDropdown' });

type NavItem = {
  id: string;
  label: string;
  to: string;
  icon: string;
};

const items: NavItem[] = [
  { id: 'books', label: 'Books', to: '/books', icon: 'lucide:book' },
  { id: 'authors', label: 'Authors', to: '/authors', icon: 'lucide:user' },
  { id: 'series', label: 'Series', to: '/series', icon: 'lucide:layers' },
  {
    id: 'publishers',
    label: 'Publishers',
    to: '/publishers',
    icon: 'lucide:building-2',
  },
  { id: 'tags', label: 'Tags', to: '/tags', icon: 'lucide:tag' },
];

const route = useRoute();

const open = ref(false);
const anchorRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

const activeItem = computed(() => {
  return (
    items.find(
      (i) => route.path === i.to || route.path.startsWith(`${i.to}/`),
    ) ?? items[0]!
  );
});

function isActive(item: NavItem) {
  // Active for exact base route and nested routes (e.g. /authors/:id)
  return route.path === item.to || route.path.startsWith(`${item.to}/`);
}

function closeDropdown() {
  open.value = false;
}

function toggleDropdown() {
  open.value = !open.value;
}

function onDocumentPointerDown(e: MouseEvent) {
  if (!open.value) return;
  const target = e.target as Node | null;

  if (
    (panelRef.value && target && panelRef.value.contains(target)) ||
    (anchorRef.value && target && anchorRef.value.contains(target))
  ) {
    return;
  }

  closeDropdown();
}

function onDocumentKeyDown(e: KeyboardEvent) {
  if (!open.value) return;
  if (e.key === 'Escape') closeDropdown();
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeyDown);
});
</script>

<template>
  <div class="flex items-center">
    <!-- Mobile (default): dropdown -->
    <div class="relative md:hidden">
      <button
        ref="anchorRef"
        class="py-0 px-0.5 gap-2 hover:bg-transparent! rounded-none! active:bg-transparent! focus:bg-transparent!"
        :aria-expanded="open"
        aria-haspopup="menu"
        @click="toggleDropdown"
      >
        <Icon
          :name="activeItem.icon"
          class="text-(--main-color) opacity-90 shrink-0 text-2xl"
        />
        <span class="text-2xl text-(--main-color)">
          {{ activeItem.label }}
        </span>
        <Icon
          name="lucide:chevron-down"
          class="text-(--main-color) opacity-70 shrink-0"
        />
      </button>

      <div
        v-if="open"
        ref="panelRef"
        class="absolute left-0 mt-1 w-44 bg-(--bg-color) border border-(--sub-color) rounded-md shadow-lg z-50 overflow-hidden"
        role="menu"
      >
        <div class="px-3 py-2 border-(--sub-color)">
          <div class="text-xs opacity-70">View</div>
        </div>

        <div>
          <NuxtLink
            v-for="item in items"
            :key="item.id"
            :to="item.to"
            class="w-full px-3 py-2 text-left justify-start! gap-3 transition rounded-none! flex items-center"
            :class="
              isActive(item)
                ? 'bg-(--sub-color)/20 text-(--main-color)'
                : 'hover:bg-(--sub-color)/15 text-(--main-color) opacity-80 hover:opacity-100'
            "
            role="menuitem"
            @click="closeDropdown"
          >
            <Icon
              :name="item.icon"
              class="text-(--main-color) opacity-80 shrink-0"
            />
            <span class="truncate text-sm">
              {{ item.label }}
            </span>

            <Icon
              v-if="isActive(item)"
              name="lucide:check"
              class="ml-auto text-(--main-color) opacity-80 shrink-0"
            />
          </NuxtLink>
        </div>
      </div>
    </div>

    <!-- Desktop (sm+): inline nav -->
    <nav aria-label="Library views" class="hidden md:flex items-center gap-0!">
      <NuxtLink
        v-for="item in items"
        :key="item.id"
        :to="item.to"
        class="px-2 py-1 flex items-center gap-2 transition"
        :class="
          isActive(item)
            ? 'bg-(--sub-color)/20 text-(--main-color)'
            : 'hover:bg-(--sub-color)/15 text-(--main-color) opacity-80 hover:opacity-100'
        "
      >
        <Icon :name="item.icon" class="shrink-0 opacity-80" />
        <span class="text-md">{{ item.label }}</span>
      </NuxtLink>
    </nav>
  </div>
</template>
