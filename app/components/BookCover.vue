<script setup lang="ts">
type ContextMenuItemBase = {
  key: string;
  label?: string;
  disabled?: boolean;
};

type ContextMenuItemLink = ContextMenuItemBase & {
  to: string;
  onSelect?: never;
  children?: never;
};

type ContextMenuItemAction = ContextMenuItemBase & {
  onSelect: () => void | Promise<void>;
  to?: never;
  children?: never;
};

type ContextMenuItemSubmenu = ContextMenuItemBase & {
  label: string;
  children: ContextMenuItem[];
  to?: never;
  onSelect?: never;
};

type ContextMenuItem =
  | ContextMenuItemLink
  | ContextMenuItemAction
  | ContextMenuItemSubmenu;

type ContextMenuItemsProp =
  | ContextMenuItem[]
  | (() => ContextMenuItem[] | Promise<ContextMenuItem[]>);

type Props = {
  /**
   * Image URL/path to render (e.g. `/api/books/<id>/cover?variant=thumb`)
   */
  src?: string | null;

  /**
   * Optional fallback URL/path to use if `src` fails to load.
   */
  fallbackSrc?: string | null;

  /**
   * Alt text for the image.
   */
  alt?: string;

  /**
   * Title of the book.
   */
  title?: string;

  /**
   * If `true`, renders a placeholder when `src` is missing.
   * Defaults to `true`.
   */
  showPlaceholder?: boolean;

  /**
   * If `true`, displays the cover resolution (WxH) in the corner after load.
   * Defaults to `false`.
   */
  showResolution?: boolean;

  /**
   * Optional extra classes to apply to the outer wrapper.
   */
  class?: string | undefined;

  /**
   * Optional right-click/long-press context menu items.
   * When empty/omitted, context menu is disabled.
   */
  contextMenuItems?: ContextMenuItemsProp;
};

const props = withDefaults(defineProps<Props>(), {
  src: null,
  fallbackSrc: null,
  alt: 'Book cover',
  title: 'Book title',
  showPlaceholder: true,
  showResolution: false,
  class: undefined,
  contextMenuItems: () => [],
});

const userSettingsStore = useUserSettingsStore();

// Vue will merge `class` on the root automatically, but we keep a prop for explicitness.
const activeSrc = ref<string | null>(props.src ?? null);
const dimensions = ref<{ width: number; height: number } | null>(null);

const isMenuOpen = ref(false);
const menuPos = ref<{ x: number; y: number }>({ x: 0, y: 0 });
const menuEl = ref<HTMLElement | null>(null);
const menuLoading = ref(false);
const rootMenuItems = ref<ContextMenuItem[]>([]);
const submenu = ref<{
  parentKey: string;
  items: ContextMenuItem[];
  pos: { x: number; y: number };
} | null>(null);
const submenuEl = ref<HTMLElement | null>(null);
let menuLoadToken = 0;

watch(
  () => props.src,
  (next) => {
    activeSrc.value = next ?? null;
    dimensions.value = null;
  },
);

function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement | null;
  if (!img) return;

  const width = img.naturalWidth || 0;
  const height = img.naturalHeight || 0;
  if (width > 0 && height > 0) {
    dimensions.value = { width, height };
  }
}

function onImgError() {
  if (!props.fallbackSrc) return;
  if (!activeSrc.value) return;
  if (activeSrc.value === props.fallbackSrc) return;

  activeSrc.value = props.fallbackSrc;
  dimensions.value = null;
}

function closeMenu() {
  isMenuOpen.value = false;
  menuLoading.value = false;
  rootMenuItems.value = [];
  submenu.value = null;
}

async function resolveMenuItems(): Promise<ContextMenuItem[]> {
  const v = props.contextMenuItems;
  if (!v) return [];

  if (typeof v === 'function') {
    const out = v();
    return Array.isArray(out) ? out : await out;
  }

  return v;
}

async function onContextMenu(e: MouseEvent) {
  if (!props.contextMenuItems) return;
  if (
    Array.isArray(props.contextMenuItems) &&
    props.contextMenuItems.length === 0
  ) {
    return;
  }

  e.preventDefault();

  isMenuOpen.value = true;
  menuPos.value = { x: e.clientX, y: e.clientY };
  menuLoading.value = true;
  submenu.value = null;

  const token = ++menuLoadToken;
  try {
    const items = await resolveMenuItems();
    if (token !== menuLoadToken) return;

    if (!items.length) {
      closeMenu();
      return;
    }

    rootMenuItems.value = items;
  } finally {
    if (token === menuLoadToken) {
      menuLoading.value = false;
    }
  }
}

function labelForItem(item: ContextMenuItem) {
  if (item.label) return item.label;
  switch (item.key) {
    case 'view':
      return 'View';
    case 'download':
      return 'Download';
    default:
      return item.key;
  }
}

function isSubmenuItem(item: ContextMenuItem): item is ContextMenuItemSubmenu {
  return (
    'children' in item &&
    Array.isArray((item as unknown as { children?: unknown }).children)
  );
}

function isActionItem(item: ContextMenuItem): item is ContextMenuItemAction {
  return (
    'onSelect' in item &&
    typeof (item as unknown as { onSelect?: unknown }).onSelect === 'function'
  );
}

function onMenuItemKeydown(e: KeyboardEvent, item: ContextMenuItem) {
  if (item.disabled) return;
  if (e.key === 'ArrowRight' && isSubmenuItem(item)) {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement | null;
    if (target) openSubmenuFor(item, target);
    return;
  }

  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  void onMenuItemClick(item, e.currentTarget as HTMLElement | null);
}

function onSubmenuItemKeydown(e: KeyboardEvent, item: ContextMenuItem) {
  if (item.disabled) return;

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    submenu.value = null;
    return;
  }

  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  void onMenuItemClick(item, null);
}

function onMenuItemPointerEnter(item: ContextMenuItem, el: HTMLElement | null) {
  if (item.disabled) return;
  if (!isSubmenuItem(item)) {
    submenu.value = null;
    return;
  }

  if (!el) return;
  openSubmenuFor(item, el);
}

function openSubmenuFor(item: ContextMenuItemSubmenu, anchorEl: HTMLElement) {
  const rect = anchorEl.getBoundingClientRect();
  submenu.value = {
    parentKey: item.key,
    items: item.children,
    pos: { x: rect.right, y: rect.top },
  };

  nextTick(() => {
    const el = submenuEl.value;
    const s = submenu.value;
    if (!el || !s) return;

    const panelRect = el.getBoundingClientRect();
    const padding = 8;

    const opensRightOverflow =
      s.pos.x + panelRect.width + padding > window.innerWidth;
    const desiredX = opensRightOverflow
      ? rect.left - panelRect.width
      : rect.right;

    const maxX = window.innerWidth - panelRect.width - padding;
    const maxY = window.innerHeight - panelRect.height - padding;

    submenu.value = {
      ...s,
      pos: {
        x: Math.min(Math.max(padding, desiredX), Math.max(padding, maxX)),
        y: Math.min(Math.max(padding, rect.top), Math.max(padding, maxY)),
      },
    };
  });
}

async function onMenuItemClick(item: ContextMenuItem, el: HTMLElement | null) {
  if (item.disabled) return;

  if (isSubmenuItem(item)) {
    if (el) openSubmenuFor(item, el);
    return;
  }

  closeMenu();

  if (isActionItem(item)) {
    await item.onSelect();
    return;
  }

  await navigateTo(item.to);
}

watch(isMenuOpen, async (open) => {
  if (!open) return;

  await nextTick();

  const el = menuEl.value;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  const padding = 8;
  const maxX = window.innerWidth - rect.width - padding;
  const maxY = window.innerHeight - rect.height - padding;

  menuPos.value = {
    x: Math.min(Math.max(padding, menuPos.value.x), Math.max(padding, maxX)),
    y: Math.min(Math.max(padding, menuPos.value.y), Math.max(padding, maxY)),
  };
});

watchEffect((onCleanup) => {
  if (!isMenuOpen.value) return;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeMenu();
  }

  function onPointerDown(e: Event) {
    const target = e.target as Node | null;
    if (!target) return;
    if (menuEl.value?.contains(target)) return;
    if (submenuEl.value?.contains(target)) return;
    closeMenu();
  }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('mousedown', onPointerDown);
  document.addEventListener('touchstart', onPointerDown);

  onCleanup(() => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('mousedown', onPointerDown);
    document.removeEventListener('touchstart', onPointerDown);
  });
});

const hasSrc = computed(() => !!activeSrc.value);
const resolutionLabel = computed(() => {
  const d = dimensions.value;
  if (!d) return null;
  return `${d.width}×${d.height}`;
});

const menuItems = computed(() => rootMenuItems.value);
</script>

<template>
  <div
    class="relative w-full h-full rounded-sm overflow-hidden background-transparent shadow-md cover"
    :class="[
      props.class,
      userSettingsStore.activeSettings.coverStyle.glossySpine ? 'gloss' : '',
      userSettingsStore.activeSettings.coverStyle.roundedRight
        ? 'rounded-r-2xl'
        : '',
      userSettingsStore.activeSettings.coverStyle.grayscale ? 'grayscale' : '',
    ]"
    @contextmenu="onContextMenu"
  >
    <template v-if="hasSrc">
      <img
        :src="activeSrc || undefined"
        :alt="props.alt"
        loading="lazy"
        draggable="false"
        class="w-full! h-full! object-cover"
        @load="onImgLoad"
        @error="onImgError"
      />
      <div
        v-if="props.showResolution && resolutionLabel"
        class="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white leading-none z-10 pointer-events-none select-none"
      >
        {{ resolutionLabel }}
      </div>
    </template>

    <div
      v-else-if="props.showPlaceholder"
      class="flex w-full h-full bg-black/6 justify-center items-center font-serif italic p-4 text-center aspect-2/3"
    >
      {{ props.title }}
    </div>

    <Teleport to="body">
      <div
        v-if="isMenuOpen"
        ref="menuEl"
        class="fixed z-50 min-w-40 overflow-hidden rounded-md border bg-(--bg-color) text-(--text-color) shadow-lg"
        :style="{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }"
        role="menu"
        @contextmenu.prevent
      >
        <div v-if="menuLoading" class="px-3 py-2 text-sm opacity-70">
          Loading…
        </div>

        <div
          v-for="item in menuItems"
          :key="item.key"
          role="menuitem"
          tabindex="0"
          class="w-full px-3 py-2 text-left text-sm select-none"
          :class="
            item.disabled
              ? 'opacity-50 cursor-not-allowed'
              : 'hover:bg-black/6 cursor-pointer'
          "
          :aria-disabled="item.disabled ? 'true' : 'false'"
          @click="
            onMenuItemClick(item, $event.currentTarget as HTMLElement | null)
          "
          @keydown="onMenuItemKeydown($event, item)"
          @pointerenter="
            onMenuItemPointerEnter(
              item,
              $event.currentTarget as HTMLElement | null,
            )
          "
        >
          <span class="flex items-center justify-between gap-2">
            <span>{{ labelForItem(item) }}</span>
            <Icon
              v-if="'children' in item"
              name="lucide:chevron-right"
              class="opacity-70"
            />
          </span>
        </div>
      </div>

      <div
        v-if="isMenuOpen && submenu"
        ref="submenuEl"
        class="fixed z-50 min-w-40 overflow-hidden rounded-md border bg-(--bg-color) text-(--text-color) shadow-lg"
        :style="{ left: `${submenu.pos.x}px`, top: `${submenu.pos.y}px` }"
        role="menu"
        @contextmenu.prevent
      >
        <div
          v-for="item in submenu.items"
          :key="item.key"
          role="menuitem"
          tabindex="0"
          class="w-full px-3 py-2 text-left text-sm select-none"
          :class="
            item.disabled
              ? 'opacity-50 cursor-not-allowed'
              : 'hover:bg-black/6 cursor-pointer'
          "
          :aria-disabled="item.disabled ? 'true' : 'false'"
          @click="onMenuItemClick(item, null)"
          @keydown="onSubmenuItemKeydown($event, item)"
        >
          {{ labelForItem(item) }}
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* Book Cover Effect */
.gloss::before {
  content: '';
  position: absolute;
  inset: 0px;
  border-radius: 3px;
  pointer-events: none;
  filter: contrast(310%) brightness(100%);
  box-shadow: rgba(15, 15, 15, 0.1) 0px 0px 0px 1px inset;
  background: linear-gradient(
    90deg,
    rgba(0, 0, 0, 0.118) 0.65%,
    rgba(255, 255, 255, 0.2) 1.53%,
    rgba(255, 255, 255, 0.1) 2.38%,
    rgba(0, 0, 0, 0.05) 3.26%,
    rgba(255, 255, 255, 0.14) 5.68%,
    rgba(244, 244, 244, 0) 6.96%
  );
}
</style>
