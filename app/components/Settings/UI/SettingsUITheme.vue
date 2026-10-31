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
const root = ref<HTMLElement>();
const menuButton = ref<HTMLButtonElement>();
const preference = computed(() => store.activeSettings.themePreference);
const current = computed(() => appearance.resolved.value === props.theme.name);

function favorite() {
  const favorites = store.activeSettings.favoriteThemes;
  void store.updateSettings({
    favoriteThemes: props.isFavorite
      ? favorites.filter((name) => name !== props.theme.name)
      : [...favorites, props.theme.name],
  });
  menuOpen.value = false;
  menuButton.value?.focus();
}
function assign(slot: 'light' | 'dark') {
  appearance.assignSlot(slot, props.theme.name);
  menuOpen.value = false;
  menuButton.value?.focus();
}
function onFocusOut(event: FocusEvent) {
  if (!root.value?.contains(event.relatedTarget as Node | null))
    menuOpen.value = false;
}
function onEscape(event: KeyboardEvent) {
  if (!menuOpen.value) return;
  event.stopPropagation();
  menuOpen.value = false;
  menuButton.value?.focus();
}
</script>
<template>
  <div
    ref="root"
    class="theme-card relative min-w-0"
    @focusout="onFocusOut"
    @keydown.esc="onEscape"
    @contextmenu.prevent="
      menuOpen = true;
      menuButton?.focus();
    "
  >
    <div
      class="theme-item flex w-full items-center rounded-full border-2 font-mono"
      :style="{
        backgroundColor: theme.bgColor,
        color: theme.textColor,
        borderColor: current ? theme.mainColor : theme.subColor,
      }"
    >
      <button
        type="button"
        class="theme-select min-w-0 flex-1 text-left rounded-full px-3 py-1"
        :aria-pressed="
          preference.mode === 'fixed' && preference.fixed === theme.name
        "
        :aria-label="`Use ${theme.name} as fixed theme${preference.light === theme.name ? ', system light' : ''}${preference.dark === theme.name ? ', system dark' : ''}`"
        @click="appearance.selectFixed(theme.name)"
      >
        <span v-if="isFavorite" aria-hidden="true">★</span>
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
      <button
        ref="menuButton"
        type="button"
        class="theme-menu-button rounded-full px-2 py-1"
        :aria-label="`Options for ${theme.name}`"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        ⋯
      </button>
    </div>
    <div
      v-if="menuOpen"
      class="theme-menu absolute right-0 z-30 mt-1 flex min-w-48 flex-col rounded-lg border border-(--sub-color) bg-(--bg-color) p-1 text-(--text-color) shadow-lg"
    >
      <button type="button" @click="assign('light')">
        Use for system light
      </button>
      <button type="button" @click="assign('dark')">Use for system dark</button>
      <button type="button" @click="favorite">
        {{ isFavorite ? 'Remove favorite' : 'Add favorite' }}
      </button>
    </div>
  </div>
</template>
<style scoped>
.theme-select,
.theme-menu-button {
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
  gap: 0.15rem;
}
.theme-swatches span {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
}
.theme-select:focus-visible,
.theme-menu-button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
.theme-select:hover,
.theme-menu-button:hover {
  background: color-mix(in srgb, currentColor 15%, transparent) !important;
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
