<script setup lang="ts">
/** The value */
const model = defineModel<number>();

/**
 * Props for SettingsUISlider
 */
const props = defineProps<{
  /** Min value for range */
  min: number;
  max: number;
  displayValue?: boolean;
  valueInput?: boolean;
  suffix?: string;
  title?: string;
  description?: string;
}>();

/**
 * Draft string for the numeric input so users can freely type (including empty string),
 * while we only commit valid values to the v-model.
 */
const draftValue = ref<string>('');

/** Consider valid numbers only; allow empty as "editing" state. */
function parseDraft(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // Only accept regular finite numbers.
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;

  return n;
}

const draftNumber = computed(() => parseDraft(draftValue.value));

const isOutOfRange = computed(() => {
  const n = draftNumber.value;
  if (n == null) return false; // don't show error while empty/invalid mid-edit
  return n < props.min || n > props.max;
});

function clampToRange(value: number) {
  return Math.min(props.max, Math.max(props.min, value));
}

/**
 * Keep draft in sync when the external model changes (slider drag, parent update).
 * Also clamp model to range (e.g. if parent sets it out of range).
 */
watch(
  [model, () => props.min, () => props.max],
  ([next]) => {
    if (next == null) return;

    const clamped = clampToRange(next);
    if (clamped !== next) {
      model.value = clamped;
      return;
    }

    draftValue.value = String(clamped);
  },
  { immediate: true },
);

/** Commit draft -> model only when draft is a valid finite number. */
function commitDraft() {
  const n = draftNumber.value;
  if (n == null) return;

  const clamped = clampToRange(n);
  model.value = clamped;
  draftValue.value = String(clamped);
}

const popupVisible = ref(false);
const popupRef = ref<HTMLElement | null>(null);

// Close on escape or outside click
function handleClickOutside(event: MouseEvent) {
  if (popupRef.value && !popupRef.value.contains(event.target as Node)) {
    popupVisible.value = false;
  }
}
function handleEscapeKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    popupVisible.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
  document.addEventListener('keydown', handleEscapeKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  document.removeEventListener('keydown', handleEscapeKey);
});
</script>

<template>
  <div
    class="w-full grid grid-cols-1 sm:grid-cols-[1fr_min-content] sm:grid-rows-2 items-center gap-2 relative setting-select-item"
  >
    <div
      v-if="title"
      :class="[
        'row-start-1 col-start-1 settings-item-title',
        !description && 'row-span-2',
      ]"
    >
      {{ title }}
    </div>
    <div
      v-if="description"
      class="row-start-2 col-start-1 italic font-light text-sm settings-item-description"
    >
      {{ description }}
    </div>

    <!-- Custom Slider -->
    <div
      class="flex flex-col items-end gap-1 col-start-1 row-start-3 sm:col-start-2 sm:row-start-1 sm:row-span-2 justify-self-start w-full"
    >
      <div class="flex gap-1 items-center grow w-full">
        <input
          v-model.number="model"
          class="slider w-full! sm:w-40!"
          type="range"
          :min="props.min"
          :max="props.max"
        />
        <div v-if="props.displayValue && !props.valueInput">
          {{ model }}{{ props.suffix }}
        </div>
        <div v-if="props.valueInput" class="flex gap-2 items-center">
          <input
            :value="draftValue"
            class="w-20 text-right"
            inputmode="numeric"
            :min="props.min"
            :max="props.max"
            :class="[isOutOfRange && 'outline-2! outline-(--error-color)! ']"
            @input="draftValue = ($event.target as HTMLInputElement).value"
            @blur="commitDraft"
            @keydown.enter.prevent="commitDraft"
          />
          <span>{{ props.suffix }}</span>
        </div>
      </div>
      <div
        class="flex row-start-2 col-start-2 text-(--error-color) justify-end text-sm"
      >
        <span v-if="Number(draftValue) < props.min"
          >Value must be >= {{ props.min }}</span
        >
        <span v-if="Number(draftValue) > props.max"
          >Value must be &lt;= {{ props.max }}</span
        >
      </div>
    </div>
  </div>
</template>

<style scoped></style>
