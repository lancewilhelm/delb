<script setup lang="ts">
const userSettingsStore = useUserSettingsStore();
const appearance = useThemeAppearance();
const uiStore = useUiStore();
const dialogRef = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
function containFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const controls = Array.from(
    dialogRef.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
    ) ?? [],
  );
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  const index = controls.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    controls[controls.length - 1]?.focus();
  } else if (
    !event.shiftKey &&
    (index === -1 || index === controls.length - 1)
  ) {
    event.preventDefault();
    controls[0]?.focus();
  }
}

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
  if (['/login', '/register'].includes(route.path)) return;
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;
  if (cmdOrCtrl && event.shiftKey && event.key.toLowerCase() === 'p') {
    event.preventDefault();
    uiStore.setCommandPaletteVisible(!uiStore.commandPaletteVisible);
    nextTick(() => inputRef.value?.focus());
  } else if (event.key === 'Escape') {
    closePalette();
  }
}
onMounted(() => {
  window.addEventListener('keydown', handleKeyDown);
  if (inputRef.value) inputRef.value.focus();
});

onBeforeUnmount(() => window.removeEventListener('keydown', handleKeyDown));

watch(
  () => uiStore.commandPaletteVisible,
  (newVal) => {
    if (newVal) {
      previousFocus = document.activeElement as HTMLElement;
      nextTick(() => {
        inputRef.value?.focus();
      });
    } else {
      previousFocus?.focus();
      previousFocus = null;
    }
  },
);
</script>

<template>
  <div
    v-if="uiStore.commandPaletteVisible"
    class="fixed top-0 left-0 w-full h-full flex items-center justify-center z-5000 bg-black/20"
    @click="closePalette"
    @mouseover="
      selectedOption?.label === 'theme' ||
      selectedOption?.label === 'favorite themes'
        ? debouncedPreviewTheme()
        : null
    "
  >
    <div
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      class="flex flex-col backdrop-blur-lg bg-(--bg-color)/80 w-150 h-150 m-4 rounded-lg shadow-lg font-mono command-palette border border-(--sub-color)"
      @keydown="containFocus"
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
          role="combobox"
          aria-label="Command palette"
          aria-expanded="true"
          aria-controls="command-palette-options"
          :aria-activedescendant="
            highlightedIndex >= 0
              ? `command-palette-option-${highlightedIndex}`
              : undefined
          "
          placeholder="search"
          class="w-full bg-transparent! px-2! rounded-t-lg! rounded-b-none! focus:outline-none command-palette-input"
          @keydown="handleInputKeydown"
        />
      </div>
      <button
        v-if="selectedOption"
        type="button"
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
      </button>
      <div class="h-full overflow-hidden command-palette-options">
        <div
          v-if="
            selectedOption?.label === 'theme' ||
            selectedOption?.label === 'favorite themes'
          "
          id="command-palette-options"
          ref="optionsRef"
          role="listbox"
          class="h-full overflow-y-auto"
        >
          <CommandPaletteThemeItem
            v-for="(theme, i) in filteredThemes"
            :id="`command-palette-option-${i}`"
            :key="theme.name"
            :ref="
              (el) => {
                const domEl = el && 'el' in el && el.el ? el.el : el;
                setOptionRef(domEl as HTMLElement, i);
              }
            "
            role="option"
            :aria-selected="highlightedIndex === i"
            :theme="theme"
            :highlighted="highlightedIndex === i"
            :selected="appearance.resolved.value === theme.name"
            @select="selectTheme"
            @preview="debouncedPreviewTheme"
            @add-favorite="
              () => {
                userSettingsStore.updateSettings({
                  favoriteThemes: [
                    ...(userSettingsStore.activeSettings.favoriteThemes || []),
                    theme.name,
                  ],
                });
              }
            "
            @delete-favorite="
              () => {
                userSettingsStore.updateSettings({
                  favoriteThemes:
                    userSettingsStore.activeSettings.favoriteThemes.filter(
                      (t: string) => t !== theme.name,
                    ),
                });
              }
            "
          />
        </div>
        <div
          v-else-if="
            selectedOption?.slider !== undefined &&
            selectedOption?.slider !== null
          "
          class="flex flex-col w-full px-4 py-2 gap-2"
        >
          {{ selectedOption.label }}
          <div class="flex items-center gap-4 w-full">
            <input
              v-model.number="selectedOption.slider.model"
              class="slider w-full!"
              type="range"
              :aria-label="selectedOption.label"
              :min="selectedOption.slider.min"
              :max="selectedOption.slider.max"
            />
            {{ selectedOption.slider.model }}{{ selectedOption.slider.suffix }}
          </div>
        </div>
        <div
          v-else
          id="command-palette-options"
          ref="optionsRef"
          role="listbox"
          class="overflow-y-auto"
        >
          <div
            v-for="(option, i) in filteredOptions"
            :id="`command-palette-option-${i}`"
            :key="i"
            :ref="(el: Element | null) => setOptionRef(el as HTMLElement, i)"
            role="option"
            :aria-selected="highlightedIndex === i"
            class="h-9 cursor-pointer px-3 py-1 hover:bg-(--sub-alt-color) flex items-center justify-between command-palette-option"
            :class="[
              highlightedIndex === i
                ? 'bg-(--sub-color) text-(--text-color)'
                : '',
            ]"
            @click="selectOption(option)"
          >
            <div class="flex items-center gap-2">
              <Icon v-if="option.icon" :name="option.icon" class="scale-125" />
              {{ option.label }}
              <Icon
                v-if="option.active"
                name="lucide:check"
                class="scale-125"
              />
            </div>
            <Icon
              v-if="option.toggle"
              :name="option.toggle.model ? 'ri:toggle-fill' : 'ri:toggle-line'"
              class="text-3xl"
            />
          </div>
          <div v-if="filteredOptions.length === 0" class="p-3">no results</div>
        </div>
      </div>
    </div>
  </div>
</template>
