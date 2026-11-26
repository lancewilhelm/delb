<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core';
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

type NavItem = {
  label: string;
  to: string;
  icon: string;
};

const dashboard: NavItem = {
  label: 'Dashboard',
  to: '/',
  icon: 'lucide:layout-dashboard',
};
const primaryItems: NavItem[] = [
  dashboard,
  { label: 'Books', to: '/books', icon: 'lucide:book' },
  { label: 'Shelves', to: '/shelves', icon: 'lucide:library' },
  { label: 'To be read', to: '/to-be-read', icon: 'lucide:list-ordered' },
];
const catalogItems: NavItem[] = [
  { label: 'Authors', to: '/authors', icon: 'lucide:user' },
  { label: 'Series', to: '/series', icon: 'lucide:layers' },
  { label: 'Publishers', to: '/publishers', icon: 'lucide:building-2' },
  { label: 'Genres', to: '/genres', icon: 'lucide:shapes' },
  { label: 'Tags', to: '/tags', icon: 'lucide:tag' },
];
const items = [...primaryItems, ...catalogItems];
const moreIcon = 'lucide:ellipsis';
const route = useRoute();

const layout = ref<'full' | 'compact' | 'collapsed'>('collapsed');
const open = ref(false);
const panelId = useId();
const navRef = ref<HTMLElement | null>(null);
const anchorRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const primaryMeasure = ref<HTMLElement | null>(null);
const catalogMeasure = ref<HTMLElement | null>(null);
const moreMeasure = ref<HTMLElement | null>(null);

const activeItem = computed(() => items.find(isActive) ?? dashboard);
const visibleItems = computed(() => {
  if (layout.value === 'full') return items;
  if (layout.value === 'compact') return primaryItems;
  return [];
});
const menuItems = computed(() =>
  layout.value === 'compact' ? catalogItems : items,
);
const catalogIsActive = computed(() => catalogItems.some(isActive));

function isActive(item: NavItem) {
  return route.path === item.to || route.path.startsWith(`${item.to}/`);
}

function updateLayout() {
  if (
    !navRef.value ||
    !primaryMeasure.value ||
    !catalogMeasure.value ||
    !moreMeasure.value
  )
    return;

  const available = navRef.value.getBoundingClientRect().width;
  const primary = primaryMeasure.value.getBoundingClientRect().width;
  const catalog = catalogMeasure.value.getBoundingClientRect().width;
  const more = moreMeasure.value.getBoundingClientRect().width;

  if (available >= primary + catalog) layout.value = 'full';
  else if (available >= primary + more) layout.value = 'compact';
  else layout.value = 'collapsed';
}

useResizeObserver(
  [navRef, primaryMeasure, catalogMeasure, moreMeasure],
  updateLayout,
);
watch([layout, () => route.path], closeDropdown);

function closeDropdown() {
  open.value = false;
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value || !(event.target instanceof Node)) return;
  if (
    panelRef.value?.contains(event.target) ||
    anchorRef.value?.contains(event.target)
  )
    return;
  closeDropdown();
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return;
  event.stopPropagation();
  closeDropdown();
  anchorRef.value?.focus();
}

onMounted(() => {
  updateLayout();
  document.addEventListener('pointerdown', onDocumentPointerDown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
});
</script>

<template>
  <nav
    ref="navRef"
    aria-label="Views"
    class="relative flex min-w-0 flex-1 items-center"
    @keydown="onKeyDown"
  >
    <RouterLink
      v-for="item in visibleItems"
      :key="item.to"
      :to="item.to"
      class="view-tab"
      :aria-current="isActive(item) ? 'page' : undefined"
      :class="{ 'view-tab-current': isActive(item) }"
    >
      <Icon :name="item.icon" class="shrink-0 opacity-80" />
      <span>{{ item.label }}</span>
    </RouterLink>

    <div v-if="layout !== 'full'" class="relative min-w-0">
      <button
        ref="anchorRef"
        type="button"
        class="max-w-full"
        :class="
          layout === 'compact'
            ? ['view-tab', { 'view-tab-current': open || catalogIsActive }]
            : 'p-1 gap-2 hover:bg-transparent! rounded-none! active:bg-transparent! focus:bg-transparent!'
        "
        :aria-expanded="open"
        :aria-controls="open ? panelId : undefined"
        @click="open = !open"
      >
        <template v-if="layout === 'compact'">
          <Icon :name="moreIcon" class="shrink-0 opacity-80" />
          <span>More</span>
        </template>
        <template v-else>
          <Icon
            :name="activeItem.icon"
            class="text-(--contrast-main-color) opacity-90 shrink-0 text-2xl"
          />
          <span class="truncate text-xl text-(--contrast-main-color)">
            {{ activeItem.label }}
          </span>
          <Icon
            name="lucide:chevron-down"
            class="text-(--contrast-main-color) opacity-70 shrink-0 transition"
            :class="open ? 'rotate-180' : ''"
          />
        </template>
      </button>

      <div
        v-if="open"
        :id="panelId"
        ref="panelRef"
        class="absolute mt-1 max-h-[calc(100dvh-6rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-44 overflow-y-auto rounded-md border border-(--contrast-border-color) bg-(--bg-color) shadow-lg z-150"
        :class="layout === 'compact' ? 'right-0' : 'left-0'"
      >
        <RouterLink
          v-for="item in menuItems"
          :key="item.to"
          :to="item.to"
          class="w-full px-3 py-2 text-left justify-start! gap-3 transition rounded-none! flex items-center"
          :aria-current="isActive(item) ? 'page' : undefined"
          :class="
            isActive(item)
              ? 'bg-(--sub-color)/20 text-(--contrast-main-color)'
              : 'hover:bg-(--sub-color)/15 text-(--contrast-main-color) opacity-80 hover:opacity-100'
          "
          @click="closeDropdown"
        >
          <Icon :name="item.icon" class="opacity-80 shrink-0" />
          <span class="truncate text-sm">{{ item.label }}</span>
          <Icon
            v-if="isActive(item)"
            name="lucide:check"
            class="ml-auto opacity-80 shrink-0"
          />
        </RouterLink>
      </div>
    </div>

    <!-- Measure unwrapped labels, independent of which links are visible. -->
    <div
      class="absolute inset-0 overflow-hidden invisible pointer-events-none"
      aria-hidden="true"
    >
      <div class="flex w-max">
        <div ref="primaryMeasure" class="flex">
          <span v-for="item in primaryItems" :key="item.to" class="view-tab">
            <Icon :name="item.icon" class="shrink-0" />
            <span>{{ item.label }}</span>
          </span>
        </div>
        <div ref="catalogMeasure" class="flex">
          <span v-for="item in catalogItems" :key="item.to" class="view-tab">
            <Icon :name="item.icon" class="shrink-0" />
            <span>{{ item.label }}</span>
          </span>
        </div>
        <span ref="moreMeasure" class="view-tab">
          <Icon :name="moreIcon" class="shrink-0" />
          <span>More</span>
        </span>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.view-tab {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  white-space: nowrap;
  border-radius: 0;
  background-color: transparent;
  color: var(--contrast-main-color);
  opacity: 0.8;
  transition: var(--transition);
}

.view-tab:hover {
  background-color: color-mix(in oklab, var(--sub-color) 15%, transparent);
  opacity: 1;
}

.view-tab.view-tab-current {
  background-color: color-mix(in oklab, var(--sub-color) 20%, transparent);
  opacity: 1;
}

.view-tab:focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: -2px;
}
</style>
