<script setup lang="ts">
/** The value */
const model = defineModel<number | string | null>();

/**
 * Props for SettingsUISlider
 */
const props = defineProps<{
  /** Min value for range */
  displayValue?: boolean;
  valueInput?: boolean;
  suffix?: string;
  title?: string;
  description?: string;
}>();

function parseMaybeNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;

  const raw = (input ?? '').toString().trim();
  if (!raw) return null;

  // Allow user-typed intermediates ("-", ".", "-.") without committing to the model.
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) return null;

  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const inputValue = ref('');
const isEditing = ref(false);

watchEffect(() => {
  if (isEditing.value) return;
  const n = parseMaybeNumber(model.value);
  inputValue.value = n === null ? '' : String(n);
});

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  inputValue.value = el.value;

  const n = parseMaybeNumber(inputValue.value);
  if (n !== null) model.value = n;
}

function onFocus() {
  isEditing.value = true;
}

function onBlur() {
  isEditing.value = false;

  const n = parseMaybeNumber(inputValue.value);
  if (n !== null) {
    model.value = n;
    inputValue.value = String(n);
    return;
  }

  const current = parseMaybeNumber(model.value) ?? 0;
  model.value = current;
  inputValue.value = String(current);
}
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
      class="row-start-2 col-start-1 italic font-light text-sm settings-item-description text-(--text-color)/80"
    >
      {{ description }}
    </div>

    <!-- Custom Slider -->
    <div
      class="flex flex-col items-end gap-1 col-start-1 row-start-3 sm:col-start-2 sm:row-start-1 sm:row-span-2 justify-self-start w-full"
    >
      <div class="flex gap-1 items-center grow w-full">
        <div class="flex gap-2 items-center">
          <input
            :value="inputValue"
            type="number"
            class="w-20 text-right"
            inputmode="numeric"
            @input="onInput"
            @focus="onFocus"
            @blur="onBlur"
          />
          <span>{{ props.suffix }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
