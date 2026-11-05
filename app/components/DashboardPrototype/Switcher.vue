<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';

const props = withDefaults(
  defineProps<{ current: string; includeCurrent?: boolean }>(),
  {
    includeCurrent: true,
  },
);
const emit = defineEmits<{ select: [variant: string] }>();
const secondRound = computed(() => ['D', 'E', 'F'].includes(props.current));
const variants = computed(() => [
  ...(props.includeCurrent
    ? [
        {
          key: 'current',
          name: 'Current dashboard',
          detail: 'Original layout for comparison',
        },
      ]
    : []),
  ...(secondRound.value
    ? [
        {
          key: 'D',
          name: 'Open tabs',
          detail: 'Counts above · visible shelf choices',
        },
        {
          key: 'E',
          name: 'Quiet dropdown',
          detail: 'Counts above · one simple shelf picker',
        },
        {
          key: 'F',
          name: 'Compact switch',
          detail: 'Counts above · grouped shelf buttons',
        },
      ]
    : [
        {
          key: 'A',
          name: 'Quiet alignment',
          detail: 'Same hierarchy · one shared width',
        },
        {
          key: 'B',
          name: 'Balanced columns',
          detail: 'Library counts beside your reading',
        },
        {
          key: 'C',
          name: 'Reading first',
          detail: 'Books first · a quieter count strip',
        },
      ]),
]);
const selected = computed(
  () =>
    variants.value.find((variant) => variant.key === props.current) ??
    variants.value[0]!,
);

function cycle(direction: number) {
  const index = variants.value.findIndex(
    (variant) => variant.key === props.current,
  );
  const next =
    variants.value[
      (index + direction + variants.value.length) % variants.value.length
    ];
  if (next) emit('select', next.key);
}

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
    return;
  if (
    event.target instanceof Element &&
    event.target.closest('input, textarea, select, [contenteditable]')
  )
    return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  cycle(event.key === 'ArrowLeft' ? -1 : 1);
}

onMounted(() => document.addEventListener('keydown', onKeyDown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeyDown));
</script>

<template>
  <aside class="study-switcher" aria-label="Dashboard prototype controls">
    <div class="study-switcher-topline">
      <span>LAYOUT STUDY</span>
      <div class="study-switcher-tabs" aria-label="Choose layout">
        <button
          v-for="variant in variants"
          :key="variant.key"
          type="button"
          :aria-pressed="current === variant.key"
          :aria-label="variant.name"
          @click="emit('select', variant.key)"
        >
          {{ variant.key === 'current' ? 'Original' : variant.key }}
        </button>
      </div>
    </div>
    <div class="study-switcher-cycle">
      <button type="button" aria-label="Previous layout" @click="cycle(-1)">
        ←
      </button>
      <div aria-live="polite" aria-atomic="true">
        <strong>{{ selected.name }}</strong>
        <span>{{ selected.detail }}</span>
      </div>
      <button type="button" aria-label="Next layout" @click="cycle(1)">
        →
      </button>
    </div>
  </aside>
</template>

<style>
.study-switcher {
  box-sizing: border-box;
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  width: min(370px, calc(100% - 24px));
  padding: 10px 12px;
  border: 1px solid #555;
  border-radius: 12px;
  background: #252525;
  color: #eee;
  box-shadow: 0 8px 32px #0003;
  font:
    12px/1.4 'Geist',
    system-ui,
    sans-serif;
}

.study-switcher-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #444;
}

.study-switcher-topline > span {
  font-size: 9px;
  letter-spacing: 1.5px;
  color: #aaa;
}

.study-switcher-tabs,
.study-switcher-cycle {
  display: flex;
  align-items: center;
  gap: 4px;
}

.study-switcher button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: #bbb;
  border: 0;
  border-radius: 5px;
  padding: 4px 9px;
  cursor: pointer;
  font: inherit;
}

.study-switcher button:hover {
  background: #444;
  color: #fff;
}

.study-switcher button[aria-pressed='true'] {
  color: #1b1b1b;
  background: #eee;
}

.study-switcher button:focus-visible {
  outline: 2px solid #eee;
  outline-offset: 3px;
}

.study-switcher-cycle {
  justify-content: space-between;
  margin-top: 9px;
}

.study-switcher-cycle > button {
  font-size: 18px;
  min-width: 32px;
  min-height: 32px;
}

.study-switcher-cycle > div {
  text-align: center;
}

.study-switcher-cycle strong,
.study-switcher-cycle span {
  display: block;
}

.study-switcher-cycle strong {
  font-weight: 500;
}

.study-switcher-cycle span {
  margin-top: 2px;
  font-size: 10px;
  color: #aaa;
}
</style>
