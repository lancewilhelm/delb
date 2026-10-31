<script setup lang="ts">
const props = defineProps<{
  theme: {
    name: string;
    bgColor: string;
    mainColor: string;
    subColor: string;
    textColor: string;
  };
  isFavorite: boolean;
}>();
const store = useUserSettingsStore();
const appearance = useThemeAppearance();
const menuOpen = ref(false);
const isHovered = ref(false);
const root = ref<HTMLElement>();
const selectButton = ref<HTMLButtonElement>();
const preference = computed(() => store.activeSettings.themePreference);
const current = computed(() => appearance.resolved.value === props.theme.name);
let longPress: ReturnType<typeof setTimeout> | undefined;
let touchStart: { x: number; y: number } | undefined;
let suppressClick = false;

function cancelLongPress() {
  clearTimeout(longPress);
  longPress = undefined;
  touchStart = undefined;
}
function openMenu() {
  menuOpen.value = true;
  selectButton.value?.focus();
}
function onMenuKey(event: KeyboardEvent) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
    return;
  event.preventDefault();
  openMenu();
}
function onPointerDown(event: PointerEvent) {
  if (event.pointerType !== 'touch' || event.button !== 0) return;
  suppressClick = false;
  touchStart = { x: event.clientX, y: event.clientY };
  longPress = setTimeout(() => {
    longPress = undefined;
    suppressClick = true;
    openMenu();
  }, 500);
}
function onPointerMove(event: PointerEvent) {
  if (
    touchStart &&
    Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 10
  )
    cancelLongPress();
}
function selectTheme() {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  appearance.selectFixed(props.theme.name);
}
onBeforeUnmount(cancelLongPress);

function favorite() {
  const favorites = store.activeSettings.favoriteThemes;
  void store.updateSettings({
    favoriteThemes: props.isFavorite
      ? favorites.filter((name) => name !== props.theme.name)
      : [...favorites, props.theme.name],
  });
  menuOpen.value = false;
}
function assign(slot: 'light' | 'dark') {
  appearance.assignSlot(slot, props.theme.name);
  menuOpen.value = false;
  selectButton.value?.focus();
}
function onFocusOut(event: FocusEvent) {
  if (!root.value?.contains(event.relatedTarget as Node | null))
    menuOpen.value = false;
}
function onEscape(event: KeyboardEvent) {
  if (!menuOpen.value) return;
  event.stopPropagation();
  menuOpen.value = false;
  selectButton.value?.focus();
}
</script>
<template>
  <div
    ref="root"
    class="theme-card relative min-w-0"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
    @focusout="onFocusOut"
    @keydown.esc="onEscape"
    @contextmenu.prevent="openMenu"
  >
    <div
      class="theme-item flex w-full items-center rounded-full border-2 font-mono"
      :style="{
        backgroundColor: theme.bgColor,
        color: theme.textColor,
        borderColor: isHovered || current ? theme.mainColor : 'var(--bg-color)',
      }"
    >
      <button
        ref="selectButton"
        type="button"
        class="theme-select min-w-0 flex-1 text-left rounded-full px-3 py-1"
        :aria-pressed="current"
        :aria-label="`Use ${theme.name} as fixed theme${preference.light === theme.name ? ', system light' : ''}${preference.dark === theme.name ? ', system dark' : ''}`"
        :aria-expanded="menuOpen"
        @keydown="onMenuKey"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="cancelLongPress"
        @pointercancel="cancelLongPress"
        @click="selectTheme"
      >
        <span class="truncate">{{ theme.name }}</span>
        <span
          v-if="preference.light === theme.name"
          class="slot-label"
          title="Light system theme"
          >Light</span
        >
        <span
          v-if="preference.dark === theme.name"
          class="slot-label"
          title="Dark system theme"
          >Dark</span
        >
      </button>
      <button
        type="button"
        class="theme-favorite rounded-full p-1"
        :class="{ 'is-favorite': isFavorite }"
        :aria-label="`${isFavorite ? 'Remove' : 'Add'} ${theme.name} ${isFavorite ? 'from' : 'to'} favorites`"
        :aria-pressed="isFavorite"
        @click="favorite"
      >
        <Icon :name="isFavorite ? 'fa6-solid:star' : 'fa6-regular:star'" />
      </button>
      <span class="theme-swatches" aria-hidden="true">
        <span
          v-for="(color, index) in [
            theme.mainColor,
            theme.subColor,
            theme.textColor,
          ]"
          :key="`${color}-${index}`"
          :style="{ backgroundColor: color }"
        />
      </span>
    </div>
    <div
      v-if="menuOpen"
      class="theme-menu absolute right-0 z-30 mt-1 flex min-w-48 flex-col rounded-lg border border-(--sub-color) bg-(--bg-color) p-1 text-(--text-color) shadow-lg"
    >
      <button type="button" @click="assign('light')">
        Use for system light
      </button>
      <button type="button" @click="assign('dark')">Use for system dark</button>
    </div>
  </div>
</template>
<style scoped>
.theme-select,
.theme-favorite {
  background: transparent !important;
  color: inherit !important;
  cursor: pointer;
}
.theme-select {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.theme-swatches {
  display: flex;
  gap: 0.25rem;
  padding-right: 0.5rem;
}
.theme-swatches span {
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
}
.theme-select:focus-visible,
.theme-favorite:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
.theme-favorite {
  opacity: 0;
}
.theme-favorite.is-favorite,
.theme-card:hover .theme-favorite,
.theme-favorite:focus-visible {
  opacity: 1;
}
@media (hover: none) {
  .theme-favorite {
    opacity: 1;
  }
}
.slot-label {
  font-size: 0.65rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  padding: 0 0.3rem;
}
.theme-menu button {
  background: transparent !important;
  color: inherit !important;
  text-align: left;
  padding: 0.5rem;
  border-radius: 0.3rem;
  cursor: pointer;
}
.theme-menu button:hover,
.theme-menu button:focus-visible {
  background: var(--sub-alt-color) !important;
}
</style>
