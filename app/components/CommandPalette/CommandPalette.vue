<script setup lang="ts">
const userSettingsStore = useUserSettingsStore();
const uiStore = useUiStore();

// --- Palette State
const {
  query,
  selectedOption,
  highlightedIndex,
  inputRef,
  optionsRef,
  filteredOptions,
  filteredThemes,
  selectOption,
  selectTheme,
  handleInputKeydown,
  setOptionRef,
  closePalette,
  debouncedPreviewTheme,
} = useCommandPalette();

// --- Keybinding for palette open/close
const route = useRoute();
function handleKeyDown(event: KeyboardEvent) {
  if (["/login", "/register"].includes(route.path)) return;
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;
  if (cmdOrCtrl && event.shiftKey && event.key.toLowerCase() === "p") {
    event.preventDefault();
    uiStore.setCommandPaletteVisible(!uiStore.commandPaletteVisible);
    nextTick(() => inputRef.value?.focus());
  } else if (event.key === "Escape") {
    closePalette();
  }
}
onMounted(() => {
  window.addEventListener("keydown", handleKeyDown);
  if (inputRef.value) inputRef.value.focus();
});

onBeforeUnmount(() => window.removeEventListener("keydown", handleKeyDown));

watch(
  () => uiStore.commandPaletteVisible,
  (newVal) => {
    if (newVal) {
      nextTick(() => {
        inputRef.value?.focus();
      });
    }
  },
);
</script>

<template>
  <div
    v-if="uiStore.commandPaletteVisible"
    class="fixed top-0 left-0 w-full h-full flex items-center justify-center z-50 bg-black/20"
    @click="closePalette"
    @mouseover="
      selectedOption?.label === 'theme' ||
      selectedOption?.label === 'favorite themes'
        ? debouncedPreviewTheme()
        : null
    "
  >
    <div
      class="flex flex-col backdrop-blur-lg bg-(--bg-color)/80 w-[600px] h-[600px] m-4 rounded-lg shadow-lg font-mono command-palette border border-(--sub-color)"
      @click.stop
    >
      <div
        class="h-12 flex items-center px-3 py-2 border-b border-(--sub-color) command-palette-search"
      >
        <Icon name="lucide:search" class="scale-125" />
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          placeholder="search"
          class="w-full bg-transparent! px-2! rounded-t-lg! rounded-b-none! focus:outline-none command-palette-input"
          @keydown="handleInputKeydown"
        />
      </div>
      <div
        v-if="selectedOption"
        class="flex items-center gap-2 px-3 cursor-pointer hover:bg-(--sub-alt-color) command-palette-back h-9 border-b border-(--sub-color)"
        @click="
          () => {
            selectedOption = undefined;
          }
        "
      >
        <Icon
          name="lucide:arrow-left"
          class="text-(--main-color) scale-125 header-icon"
        />
        back
      </div>
      <div class="h-full overflow-hidden command-palette-options">
        <div
          v-if="
            selectedOption?.label === 'theme' ||
            selectedOption?.label === 'favorite themes'
          "
          ref="optionsRef"
          class="h-full overflow-y-auto"
        >
          <CommandPaletteThemeItem
            v-for="(theme, i) in filteredThemes"
            :key="theme.name"
            :ref="
              (el) => {
                const domEl = el && 'el' in el && el.el ? el.el : el;
                setOptionRef(domEl as HTMLElement, i);
              }
            "
            :theme="theme"
            :highlighted="highlightedIndex === i"
            :selected="userSettingsStore.settings.theme === theme.name"
            @select="selectTheme"
            @preview="debouncedPreviewTheme"
            @add-favorite="
              () => {
                userSettingsStore.updateSettings({
                  favoriteThemes: [
                    ...(userSettingsStore.settings.favoriteThemes || []),
                    theme.name,
                  ],
                });
              }
            "
            @delete-favorite="
              () => {
                userSettingsStore.updateSettings({
                  favoriteThemes:
                    userSettingsStore.settings.favoriteThemes.filter(
                      (t: string) => t !== theme.name,
                    ),
                });
              }
            "
          />
        </div>
        <div v-else ref="optionsRef" class="overflow-y-auto">
          <div
            v-for="(option, i) in filteredOptions"
            :key="i"
            :ref="(el) => setOptionRef(el as HTMLElement, i)"
            class="h-9 cursor-pointer px-3 py-1 hover:bg-(--sub-alt-color) flex items-center gap-2 command-palette-option"
            :class="[
              highlightedIndex === i
                ? 'bg-(--sub-color) text-(--text-color)'
                : '',
            ]"
            @click="selectOption(option)"
          >
            <Icon v-if="option.icon" :name="option.icon" class="scale-125" />
            {{ option.label }}
            <Icon v-if="option.active" name="lucide:check" class="scale-125" />
          </div>
          <div v-if="filteredOptions.length === 0" class="p-3">no results</div>
        </div>
      </div>
    </div>
  </div>
</template>
