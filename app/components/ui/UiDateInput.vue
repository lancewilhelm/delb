<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { isCompleteDate } from '~/utils/dateInput';

/**
 * A date field that lets the reader type a whole date without interruption.
 *
 * Browsers report a value as soon as a partly typed date is valid (typing the
 * first digit of a year gives year 0002), so saving on every change interrupts
 * typing. This field keeps its own draft while focused and commits it on blur,
 * on Enter, or after a short pause once the date is complete, which also covers
 * dates chosen from the browser's calendar. It never disables itself, and a new
 * value from the parent does not replace a draft that the reader is editing.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    disabled?: boolean;
    clearable?: boolean;
    ariaLabel?: string;
    inputClass?: string;
    commitDelayMs?: number;
  }>(),
  {
    disabled: false,
    clearable: false,
    ariaLabel: undefined,
    inputClass: '',
    commitDelayMs: 900,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  commit: [value: string];
}>();

const input = ref<HTMLInputElement | null>(null);
const draft = ref(props.modelValue);
const focused = ref(false);
let committed = props.modelValue;
let timer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.modelValue,
  (value) => {
    committed = value;
    if (!focused.value) draft.value = value;
  },
);

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function commit(value: string) {
  clearTimer();
  if (value === committed) return;
  committed = value;
  emit('update:modelValue', value);
  emit('commit', value);
}

function revert() {
  clearTimer();
  draft.value = committed;
  if (input.value) input.value.value = committed;
}

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  draft.value = value;
  clearTimer();
  if (isCompleteDate(value)) {
    timer = setTimeout(() => commit(value), props.commitDelayMs);
  }
}

/** Commit what the reader entered, or restore the saved date if it is incomplete. */
function settle() {
  const value = draft.value;
  if (value === '') {
    // A partly typed date also reads as empty; only a truly empty field clears.
    if (input.value?.validity.badInput) revert();
    else commit('');
    return;
  }
  if (isCompleteDate(value)) commit(value);
  else revert();
}

function onBlur() {
  focused.value = false;
  settle();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    settle();
  } else if (event.key === 'Escape' && draft.value !== committed) {
    event.stopPropagation();
    revert();
  }
}

function clear() {
  draft.value = '';
  if (input.value) input.value.value = '';
  commit('');
}

onBeforeUnmount(() => {
  // Keep a complete date that was waiting for its pause to end.
  if (timer && isCompleteDate(draft.value)) commit(draft.value);
  clearTimer();
});
</script>

<template>
  <span class="flex min-w-0 items-center gap-1">
    <input
      ref="input"
      type="date"
      :value="draft"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :class="inputClass"
      @input="onInput"
      @focus="focused = true"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <button
      v-if="clearable && draft && !disabled"
      type="button"
      class="p-1 rounded-md opacity-60 hover:opacity-100 hover:bg-(--sub-color)/10"
      :aria-label="
        ariaLabel ? `Clear ${ariaLabel.toLowerCase()}` : 'Clear date'
      "
      @click="clear"
    >
      <Icon name="lucide:x" />
    </button>
  </span>
</template>
