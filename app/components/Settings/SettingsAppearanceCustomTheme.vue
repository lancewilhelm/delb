<script setup lang="ts">
import {
  defaultCustomTheme,
  hexToHsv,
  hsvToHex,
  normalizeCustomTheme,
  normalizeHex,
  themeColorRoles,
  type ThemeColorKey,
} from '~/utils/customTheme';

const store = useUserSettingsStore();
const selected = ref<ThemeColorKey>('bgColor');
const palette = computed(() =>
  normalizeCustomTheme(store.activeSettings.customTheme),
);
const active = computed(() => store.activeSettings.theme === 'custom');
const hsv = ref(hexToHsv(palette.value[selected.value]));
const hexInput = ref(palette.value[selected.value]);
const square = ref<HTMLElement>();
const dragging = ref(false);
let mounted = false;
let initialization = 0;

// Capture computed values after the active preset has finished loading. This also
// handles a newly enabled mobile profile without changing its selected theme.
async function initialize() {
  const request = ++initialization;
  if (store.activeSettings.customTheme) return;
  const theme = store.activeSettings.theme;
  try {
    await loadTheme(theme || 'guage');
  } catch {
    return;
  }
  if (request !== initialization || store.activeSettings.customTheme) return;
  const styles = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(
    themeColorRoles.map(({ key, variable }) => {
      const value = styles.getPropertyValue(variable).trim();
      let hex = normalizeHex(value);
      if (!hex) {
        // Some presets use rgb() or alpha hex. Resolve and flatten to opaque RGB.
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        if (context && CSS.supports('color', value)) {
          context.fillStyle = defaultCustomTheme[key];
          context.fillRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          const pixels = context.getImageData(0, 0, 1, 1).data;
          hex =
            '#' +
            Array.from(pixels.slice(0, 3))
              .map((c) => c.toString(16).padStart(2, '0'))
              .join('');
        }
      }
      return [key, hex ?? defaultCustomTheme[key]];
    }),
  );
  void store.updateSettings({ customTheme: normalizeCustomTheme(colors) });
}
onMounted(() => {
  mounted = true;
  void initialize();
});
onBeforeUnmount(() => {
  mounted = false;
  initialization++;
});
watch(
  () => [store.usingMobileOverrides, store.activeSettings.theme],
  () => {
    if (mounted) void initialize();
  },
);
watch(
  () => [selected.value, palette.value[selected.value]] as const,
  ([key, color], previous) => {
    if (
      previous?.[0] === key &&
      hsvToHex(hsv.value.h, hsv.value.s, hsv.value.v) === color
    ) {
      hexInput.value = color;
      return;
    }
    const next = hexToHsv(color);
    // Retain hue when editing gray/black so hue and saturation controls remain useful.
    hsv.value = { ...next, h: next.s ? next.h : hsv.value.h };
    hexInput.value = color;
  },
);

function commitHsv() {
  const color = hsvToHex(hsv.value.h, hsv.value.s, hsv.value.v);
  hexInput.value = color;
  void store.updateSettings({
    customTheme: { ...palette.value, [selected.value]: color },
  });
}
function editHex(event: Event) {
  hexInput.value = (event.target as HTMLInputElement).value;
  const color = normalizeHex(hexInput.value);
  // Wait for all six digits while typing; three-digit hex is accepted on blur.
  if (color && hexInput.value.trim().length === 7) {
    void store.updateSettings({
      customTheme: { ...palette.value, [selected.value]: color },
    });
  }
}
function finishHex() {
  const color = normalizeHex(hexInput.value);
  if (color)
    void store.updateSettings({
      customTheme: { ...palette.value, [selected.value]: color },
    });
  hexInput.value = palette.value[selected.value];
}
function position(event: PointerEvent) {
  if (!square.value) return;
  const rect = square.value.getBoundingClientRect();
  hsv.value.s = Math.max(
    0,
    Math.min(1, (event.clientX - rect.left) / rect.width),
  );
  hsv.value.v =
    1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  commitHsv();
}
function pointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  square.value?.focus();
  square.value?.setPointerCapture(event.pointerId);
  dragging.value = true;
  position(event);
}
function keydown(event: KeyboardEvent) {
  const step = event.shiftKey ? 0.1 : 0.01;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
    return;
  event.preventDefault();
  if (event.key === 'ArrowLeft') hsv.value.s = Math.max(0, hsv.value.s - step);
  if (event.key === 'ArrowRight') hsv.value.s = Math.min(1, hsv.value.s + step);
  if (event.key === 'ArrowUp') hsv.value.v = Math.min(1, hsv.value.v + step);
  if (event.key === 'ArrowDown') hsv.value.v = Math.max(0, hsv.value.v - step);
  commitHsv();
}
</script>

<template>
  <div class="grid w-full grid-cols-1 md:grid-cols-2 gap-6 custom-theme-editor">
    <div class="flex flex-col justify-center gap-3">
      <button
        type="button"
        class="custom-theme-chip flex w-full items-center justify-between rounded-full border-2 px-3 py-1 font-mono cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-4"
        :style="{
          backgroundColor: palette.bgColor,
          color: palette.textColor,
          borderColor: active ? palette.mainColor : palette.subColor,
        }"
        :aria-pressed="active"
        aria-label="Use custom theme"
        @click="store.updateSettings({ theme: 'custom', customTheme: palette })"
      >
        <span>custom</span>
        <span class="flex gap-1" aria-hidden="true">
          <span
            v-for="key in ['mainColor', 'subColor', 'textColor'] as const"
            :key="key"
            class="w-4 h-4 rounded-full"
            :style="{ backgroundColor: palette[key] }"
          />
        </span>
      </button>
      <p class="text-sm text-(--sub-color)">
        Select custom to apply your colors. Changes save automatically.
      </p>
    </div>
    <div class="min-w-0">
      <div class="flex flex-wrap gap-2 mb-4" aria-label="Theme color">
        <button
          v-for="role in themeColorRoles"
          :key="role.key"
          type="button"
          class="flex items-center gap-2 rounded-lg border-2 px-2 py-1 text-sm cursor-pointer"
          :class="
            selected === role.key
              ? 'border-(--main-color)'
              : 'border-transparent'
          "
          :aria-pressed="selected === role.key"
          @click="selected = role.key"
        >
          <span
            class="w-4 h-4 rounded-full border border-current"
            :style="{ backgroundColor: palette[role.key] }"
            aria-hidden="true"
          />
          {{ role.label }}
        </button>
      </div>
      <div
        class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 items-start"
      >
        <div
          ref="square"
          role="group"
          tabindex="0"
          :aria-label="`${themeColorRoles.find((r) => r.key === selected)?.label} saturation and brightness`"
          aria-describedby="custom-color-keyboard-help"
          class="relative aspect-square rounded-lg cursor-crosshair touch-none focus-visible:outline-2 focus-visible:outline-offset-4"
          :style="{
            background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hsvToHex(hsv.h, 1, 1)}`,
          }"
          @pointerdown="pointerDown"
          @pointermove="dragging && position($event)"
          @pointerup="dragging = false"
          @pointercancel="dragging = false"
          @lostpointercapture="dragging = false"
          @keydown="keydown"
        >
          <span
            class="absolute w-3 h-3 rounded-full border-2 border-white pointer-events-none"
            :style="{
              left: `${hsv.s * 100}%`,
              top: `${(1 - hsv.v) * 100}%`,
              transform: 'translate(-50%, -50%)',
              boxShadow: '0 0 0 1px #000',
            }"
          />
        </div>
        <div class="flex flex-col gap-3 min-w-0">
          <div
            class="h-10 rounded-lg border border-(--sub-color)"
            :style="{ backgroundColor: palette[selected] }"
            aria-hidden="true"
          />
          <label class="flex flex-col gap-1 text-sm"
            >Hex color
            <input
              :value="hexInput"
              type="text"
              spellcheck="false"
              maxlength="7"
              class="w-full min-w-0 font-mono"
              :aria-invalid="!normalizeHex(hexInput)"
              @input="editHex"
              @blur="finishHex"
              @keydown.enter="finishHex"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm"
            >Hue
            <input
              v-model.number="hsv.h"
              type="range"
              min="0"
              max="359"
              step="1"
              class="hue-slider w-full"
              @input="commitHsv"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm"
            >Saturation
            <input
              v-model.number="hsv.s"
              type="range"
              min="0"
              max="1"
              step="0.01"
              class="w-full"
              @input="commitHsv"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm"
            >Brightness
            <input
              v-model.number="hsv.v"
              type="range"
              min="0"
              max="1"
              step="0.01"
              class="w-full"
              @input="commitHsv"
            />
          </label>
        </div>
      </div>
      <p
        id="custom-color-keyboard-help"
        class="mt-3 text-xs text-(--sub-color)"
      >
        Use arrow keys in the color square to adjust saturation and brightness.
        Hold Shift for larger steps.
      </p>
    </div>
  </div>
</template>

<style scoped>
.custom-theme-chip {
  justify-content: space-between;
  border-radius: 999px;
}
input:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 3px;
}
input[type='range'] {
  padding: 0;
  accent-color: var(--main-color);
}
.hue-slider {
  appearance: none;
  height: 12px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    #f00,
    #ff0,
    #0f0,
    #0ff,
    #00f,
    #f0f,
    #f00
  );
}
.hue-slider::-webkit-slider-thumb {
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #333;
}
.hue-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #333;
}
</style>
