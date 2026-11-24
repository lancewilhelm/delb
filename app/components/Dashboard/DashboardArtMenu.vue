<script setup lang="ts" generic="T extends string">
import { onClickOutside } from '@vueuse/core';
import { nextTick, ref, useId } from 'vue';

/** The ⋯ button and menu that picks a dashboard card's art style. */
const props = defineProps<{
  /** Accessible name, e.g. "Card art for To be read". */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  /** Show "Use default" (enabled when `canReset`). */
  resettable?: boolean;
  canReset?: boolean;
}>();

const emit = defineEmits<{ (e: 'choose', value: T | null): void }>();

const root = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const menuId = `dash-art-menu-${useId()}`;

onClickOutside(root, () => {
  open.value = false;
});

async function toggle() {
  open.value = !open.value;
  if (!open.value) return;
  await nextTick();
  menu.value
    ?.querySelector<HTMLButtonElement>('[aria-checked="true"], button')
    ?.focus();
}

function close() {
  open.value = false;
  trigger.value?.focus();
}

function choose(value: T | null) {
  emit('choose', value);
  close();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(
    menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ??
      [],
  );
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
          items.length;
  items[next]?.focus();
}
</script>

<template>
  <div ref="root" class="art-menu" :class="{ 'is-open': open }">
    <button
      ref="trigger"
      type="button"
      class="art-menu-trigger"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="menuId"
      :aria-label="props.label"
      @click="toggle"
    >
      <Icon name="lucide:ellipsis" />
    </button>
    <div
      v-if="open"
      :id="menuId"
      ref="menu"
      class="art-menu-list"
      role="menu"
      :aria-label="props.label"
      @keydown="onKeydown"
    >
      <div class="art-menu-head" aria-hidden="true">Card art</div>
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="menuitemradio"
        :aria-checked="option.value === value"
        @click="choose(option.value)"
      >
        {{ option.label }}
        <Icon v-if="option.value === value" name="lucide:check" />
      </button>
      <template v-if="resettable">
        <div class="art-menu-sep" role="separator"></div>
        <button
          type="button"
          role="menuitem"
          :disabled="!canReset"
          @click="choose(null)"
        >
          Use default
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.art-menu {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
}
.art-menu-trigger {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--contrast-text-color);
  background: color-mix(in srgb, var(--bg-color) 78%, transparent);
  backdrop-filter: blur(6px);
  transition: opacity 0.15s;
}
.art-menu.is-open .art-menu-trigger {
  box-shadow: 0 0 0 2px var(--main-color);
}
.art-menu-trigger:focus-visible {
  outline: 2px solid var(--main-color);
  outline-offset: 2px;
}
.art-menu-list {
  position: absolute;
  top: 34px;
  right: -4px;
  z-index: 30;
  width: 176px;
  padding: 5px;
  border-radius: 10px;
  background: var(--sub-alt-color);
  border: 1px solid color-mix(in srgb, var(--sub-color) 60%, transparent);
  box-shadow: 0 14px 34px rgb(0 0 0 / 0.35);
  color: var(--contrast-text-color);
}
.art-menu-head {
  padding: 6px 8px 4px;
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--contrast-sub-color);
}
.art-menu-list button {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 13px;
  text-align: left;
  color: inherit;
}
.art-menu-list button:hover:not(:disabled),
.art-menu-list button:focus-visible {
  background: color-mix(in srgb, var(--sub-color) 22%, transparent);
  outline: none;
}
.art-menu-list button[aria-checked='true'] {
  font-weight: 600;
}
.art-menu-list button:disabled {
  opacity: 0.5;
  cursor: default;
}
.art-menu-sep {
  height: 1px;
  margin: 4px 2px;
  background: color-mix(in srgb, var(--sub-color) 32%, transparent);
}
</style>
