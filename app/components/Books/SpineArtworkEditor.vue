<script setup lang="ts">
import {
  defaultSpineEdits,
  parseSpineEdits,
  type SpineEdits,
} from '~~/shared/spine-artwork';
const props = defineProps<{ bookId: string; disabled?: boolean }>();
const picker = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const fileUrl = ref<string | null>(null);
const revision = ref<string | null>(null);
const baseline = ref<SpineEdits>(defaultSpineEdits());
const edits = ref<SpineEdits>(defaultSpineEdits());
const removePending = ref(false);
const busy = ref(true);
const error = ref('');
const dimensions = ref<{ width: number; height: number } | null>(null);
let selection = 0;
const source = computed(() =>
  removePending.value
    ? null
    : (fileUrl.value ??
      (revision.value
        ? `/api/books/${encodeURIComponent(props.bookId)}/spine?variant=source&v=${encodeURIComponent(revision.value)}`
        : null)),
);
const changed = computed(
  () =>
    !!file.value ||
    removePending.value ||
    JSON.stringify(edits.value) !== JSON.stringify(baseline.value),
);
const aspect = computed(() => {
  if (edits.value.stretch) return 1 / 3;
  const size = dimensions.value;
  if (!size) return 1 / 3;
  return (
    (size.width * (100 - edits.value.left - edits.value.right)) /
    (size.height * (100 - edits.value.top - edits.value.bottom))
  );
});
const previewStyle = computed(() => {
  const cropWidth = 100 - edits.value.left - edits.value.right;
  const cropHeight = 100 - edits.value.top - edits.value.bottom;
  return {
    left: `${(-100 * edits.value.left) / cropWidth}%`,
    top: `${(-100 * edits.value.top) / cropHeight}%`,
    width: `${10000 / cropWidth}%`,
    height: `${10000 / cropHeight}%`,
  };
});
function clearFile() {
  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value);
  fileUrl.value = null;
  file.value = null;
  if (picker.value) picker.value.value = '';
}
function reset() {
  selection++;
  clearFile();
  edits.value = { ...baseline.value };
  removePending.value = false;
  error.value = '';
}
async function load() {
  busy.value = true;
  error.value = '';
  try {
    const meta = await $fetch<{
      exists: boolean;
      revision: string | null;
      edits: unknown;
    }>(`/api/books/${encodeURIComponent(props.bookId)}/spine?variant=metadata`);
    const saved = meta.exists
      ? parseSpineEdits(meta.edits)
      : defaultSpineEdits();
    if (!saved || (meta.exists && !meta.revision))
      throw new Error('Saved spine settings could not be read.');
    revision.value = meta.revision;
    baseline.value = saved;
    reset();
  } catch {
    error.value = 'Could not load the spine editor. Try again.';
  } finally {
    busy.value = false;
  }
}
async function chooseFile(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  const chosen = event.target.files?.[0];
  event.target.value = '';
  if (!chosen) return;
  if (!chosen.size || chosen.size > 10 * 1024 * 1024) {
    error.value = 'Choose an image under 10 MB.';
    return;
  }
  const token = ++selection;
  const url = URL.createObjectURL(chosen);
  busy.value = true;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth * image.naturalHeight > 24_000_000)
      throw new Error('Image too large');
    if (token !== selection) {
      URL.revokeObjectURL(url);
      return;
    }
    clearFile();
    file.value = chosen;
    fileUrl.value = url;
    dimensions.value = {
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
    edits.value = defaultSpineEdits();
    removePending.value = false;
    error.value = '';
  } catch {
    URL.revokeObjectURL(url);
    if (token === selection)
      error.value =
        'Could not preview that image. Choose a JPEG, PNG, WebP or AVIF under 24 megapixels.';
  } finally {
    if (token === selection) busy.value = false;
  }
}
function imageLoaded(event: Event) {
  if (event.target instanceof HTMLImageElement)
    dimensions.value = {
      width: event.target.naturalWidth,
      height: event.target.naturalHeight,
    };
}
async function save() {
  if (!changed.value) return;
  if (busy.value) throw new Error('Wait for the spine preview to finish.');
  try {
    if (removePending.value) {
      if (revision.value)
        await $fetch(`/api/books/${encodeURIComponent(props.bookId)}/spine`, {
          method: 'DELETE',
          body: { revision: revision.value },
        });
      revision.value = null;
      baseline.value = defaultSpineEdits();
      reset();
      return;
    }
    const body = new FormData();
    if (file.value) body.append('file', file.value);
    body.append('revision', revision.value ?? '');
    body.append('edits', JSON.stringify(edits.value));
    const result = await $fetch<{ revision: string }>(
      `/api/books/${encodeURIComponent(props.bookId)}/spine`,
      { method: 'POST', body },
    );
    revision.value = result.revision;
    baseline.value = { ...edits.value };
    reset();
  } catch (cause: unknown) {
    const conflict =
      typeof cause === 'object' &&
      cause !== null &&
      'statusCode' in cause &&
      cause.statusCode === 409;
    error.value = conflict
      ? 'This spine changed elsewhere. Reload the editor before saving your changes.'
      : 'The spine could not be saved. Your pending changes are still here.';
    throw new Error(error.value);
  }
}
onMounted(load);
onBeforeUnmount(() => {
  selection++;
  clearFile();
});
defineExpose({ save, reset, busy });
</script>

<template>
  <section class="spine-editor" aria-label="Spine artwork">
    <h2>Spine artwork</h2>
    <p>
      Upload artwork for the book's spine. Changes apply when you save the book.
    </p>
    <p v-if="error" role="alert" class="spine-error">
      {{ error }}
      <button v-if="!changed && !busy" type="button" @click="load">
        Retry
      </button>
    </p>
    <input
      ref="picker"
      type="file"
      class="hidden"
      accept="image/jpeg,image/png,image/webp,image/avif"
      :disabled="disabled || busy"
      @change="chooseFile"
    />
    <div v-if="source" class="preview-container">
      <div
        class="crop-preview"
        :style="{
          aspectRatio: String(aspect),
          width: `min(90px, ${280 * aspect}px)`,
        }"
      >
        <img
          :src="source"
          :style="previewStyle"
          alt="Spine artwork preview"
          @load="imageLoaded"
          @error="error = 'Could not load the spine preview.'"
        />
      </div>
    </div>
    <p v-else class="placeholder">
      No spine artwork{{ removePending ? ' after saving' : '' }}.
    </p>
    <div class="actions">
      <button
        type="button"
        :disabled="disabled || busy"
        @click="picker?.click()"
      >
        {{ revision || file ? 'Replace image' : 'Upload spine' }}</button
      ><button
        v-if="revision || file"
        type="button"
        :disabled="disabled || busy"
        @click="
          removePending = true;
          clearFile();
        "
      >
        Remove</button
      ><button
        v-if="changed"
        type="button"
        :disabled="disabled || busy"
        @click="reset"
      >
        Undo spine changes
      </button>
    </div>
    <div v-if="source" class="crop-controls">
      <label
        v-for="edge in ['left', 'right', 'top', 'bottom'] as const"
        :key="edge"
        >Crop {{ edge }} · {{ edits[edge] }}%<input
          v-model.number="edits[edge]"
          type="range"
          min="0"
          :max="
            Math.min(
              90,
              95 -
                edits[
                  edge === 'left'
                    ? 'right'
                    : edge === 'right'
                      ? 'left'
                      : edge === 'top'
                        ? 'bottom'
                        : 'top'
                ],
            )
          "
          :disabled="disabled || busy"
      /></label>
      <label class="stretch"
        ><input
          v-model="edits.stretch"
          type="checkbox"
          :disabled="disabled || busy"
        />
        Stretch to a 1:3 spine shape</label
      >
    </div>
    <p class="help">
      JPEG, PNG, WebP or AVIF, up to 10 MB. The original is kept for later
      edits.
    </p>
  </section>
</template>

<style scoped>
.spine-editor {
  width: 100%;
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--contrast-border-color);
}
.spine-editor h2 {
  font-weight: 600;
  margin-bottom: 6px;
}
.spine-editor p {
  font-size: 12px;
  opacity: 0.8;
}
.spine-error {
  color: var(--contrast-error-color);
  margin-top: 8px;
}
.preview-container {
  display: flex;
  justify-content: center;
  margin: 12px 0;
}
.crop-preview {
  position: relative;
  width: 90px;
  max-height: 280px;
  overflow: hidden;
  background: var(--sub-alt-color);
}
.crop-preview img {
  position: absolute;
  max-width: none;
  object-fit: fill;
}
.placeholder {
  padding: 16px 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.actions button,
.spine-error button {
  border: 1px solid var(--contrast-border-color);
  padding: 6px 10px;
  font-size: 12px;
}
.crop-controls {
  margin-top: 12px;
}
.crop-controls label {
  display: block;
  font-size: 12px;
  margin-top: 7px;
  text-transform: capitalize;
}
.crop-controls input[type='range'] {
  width: 100%;
  display: block;
}
.crop-controls .stretch {
  display: flex;
  align-items: center;
  gap: 7px;
  text-transform: none;
}
.help {
  margin-top: 12px;
}
</style>
