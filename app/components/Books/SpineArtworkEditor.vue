<script setup lang="ts">
import {
  defaultSpineEdits,
  parseSpineEdits,
  type SpineEdits,
} from '~~/shared/spine-artwork';
const props = defineProps<{
  bookId: string;
  hasCover: boolean;
  coverPending: boolean;
  disabled?: boolean;
}>();
const picker = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const fileUrl = ref<string | null>(null);
const revision = ref<string | null>(null);
const baseline = ref<SpineEdits>(defaultSpineEdits());
const edits = ref<SpineEdits>(defaultSpineEdits());
const removePending = ref(false);
const busy = ref(true);
const generating = ref(false);
const error = ref('');
const dimensions = ref<{ width: number; height: number } | null>(null);
const connection = ref(false);
const generated = ref(false);
const instructions = ref('');
let selection = 0;
const connectionUrl = computed(
  () =>
    `/api/books/${encodeURIComponent(props.bookId)}/spine-generate/connection`,
);
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
  generated.value = false;
}
async function loadConnection() {
  try {
    connection.value = (
      await $fetch<{ connected: boolean }>(connectionUrl.value)
    ).connected;
  } catch {
    connection.value = false;
  }
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
  if (await stageFile(chosen)) generated.value = false;
}
async function stageFile(chosen: File) {
  if (!chosen.size || chosen.size > 10 * 1024 * 1024) {
    error.value = 'Choose an image under 10 MB.';
    return false;
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
      return false;
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
    return true;
  } catch {
    URL.revokeObjectURL(url);
    if (token === selection)
      error.value =
        'Could not preview that image. Choose a JPEG, PNG, WebP or AVIF under 24 megapixels.';
    return false;
  } finally {
    if (token === selection) busy.value = false;
  }
}
async function generate() {
  const token = ++selection;
  busy.value = true;
  generating.value = true;
  error.value = '';
  try {
    const body = new FormData();
    body.append('prompt', instructions.value);
    if (generated.value && file.value) body.append('previous', file.value);
    const blob = await $fetch<Blob>(
      `/api/books/${encodeURIComponent(props.bookId)}/spine-generate`,
      { method: 'POST', body, responseType: 'blob' },
    );
    if (token !== selection) return;
    if (
      await stageFile(new File([blob], 'generated-spine', { type: blob.type }))
    )
      generated.value = true;
  } catch (cause: unknown) {
    if (token === selection) {
      let message =
        typeof cause === 'object' &&
        cause !== null &&
        'data' in cause &&
        typeof cause.data === 'object' &&
        cause.data !== null &&
        'statusMessage' in cause.data &&
        typeof cause.data.statusMessage === 'string'
          ? cause.data.statusMessage
          : 'Could not generate a spine. Try again.';
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'data' in cause &&
        cause.data instanceof Blob
      ) {
        try {
          const data: unknown = JSON.parse(await cause.data.text());
          if (
            data &&
            typeof data === 'object' &&
            'statusMessage' in data &&
            typeof data.statusMessage === 'string'
          )
            message = data.statusMessage;
        } catch {
          /* Keep the generic error when the response is not JSON. */
        }
      }
      error.value = message;
    }
  } finally {
    if (token === selection) busy.value = false;
    generating.value = false;
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
onMounted(() => {
  load();
  loadConnection();
});
onBeforeUnmount(() => {
  selection++;
  clearFile();
});
defineExpose({ save, reset, busy, generating });
</script>

<template>
  <section class="spine-editor" aria-label="Spine artwork">
    <h2>Spine artwork</h2>
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
    <div class="preview-stage" :class="{ empty: !source }">
      <div v-if="generating" class="generation-overlay" role="status">
        <Icon
          name="lucide:loader-circle"
          class="text-3xl motion-safe:animate-spin"
          aria-hidden="true"
        />
        <span>Generating spine…</span>
      </div>
      <template v-if="source">
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
        <span class="preview-label">Preview</span>
      </template>
      <template v-else>
        <span class="empty-icon"
          ><Icon name="lucide:image-plus" aria-hidden="true"
        /></span>
        <strong>{{
          busy
            ? 'Preparing preview…'
            : error
              ? 'Spine image unavailable'
              : removePending
                ? 'Spine will be removed'
                : 'No spine image yet'
        }}</strong>
        <span>{{
          busy
            ? 'Just a moment.'
            : error
              ? 'Check the message above and try again.'
              : removePending
                ? 'Save to apply this change.'
                : 'Add an image to make this book your own.'
        }}</span>
      </template>
    </div>
    <div class="actions">
      <button
        class="upload-action"
        type="button"
        :disabled="disabled || busy"
        @click="picker?.click()"
      >
        <Icon name="lucide:image-up" aria-hidden="true" />
        {{ source ? 'Replace image' : 'Upload spine' }}
      </button>
      <button
        v-if="source"
        type="button"
        :disabled="disabled || busy"
        @click="
          removePending = true;
          clearFile();
        "
      >
        <Icon name="lucide:trash-2" aria-hidden="true" /> Remove
      </button>
      <button
        v-if="changed"
        class="undo-action"
        type="button"
        :disabled="disabled || busy"
        @click="reset"
      >
        Undo changes
      </button>
    </div>
    <div class="generation">
      <div class="controls-heading">
        <div>
          <h3>Generate a spine</h3>
          <p>
            Experimental · Uses the saved cover and the connected ChatGPT
            account.
          </p>
        </div>
        <Icon name="lucide:sparkles" aria-hidden="true" />
      </div>
      <p v-if="!connection" class="generation-note">
        Spine generation is not configured. Ask an administrator to connect
        ChatGPT in Admin settings.
      </p>
      <template v-else>
        <label class="generation-label"
          >{{
            generated
              ? 'How should the preview change?'
              : 'Extra instructions (optional)'
          }}<textarea
            v-model="instructions"
            maxlength="2000"
            rows="3"
            :disabled="disabled || busy"
            placeholder="For example, make the title larger"
          />
        </label>
        <div class="actions">
          <button
            class="generate-action"
            type="button"
            :disabled="disabled || busy || !hasCover || coverPending"
            @click="generate"
          >
            <Icon
              :name="generating ? 'lucide:loader-circle' : 'lucide:sparkles'"
              :class="{ 'motion-safe:animate-spin': generating }"
              aria-hidden="true"
            />
            {{
              busy
                ? 'Generating…'
                : generated
                  ? 'Update preview'
                  : 'Generate preview'
            }}
          </button>
        </div>
        <p v-if="!hasCover" class="generation-note">
          Add and save a cover before generating a spine.
        </p>
        <p v-else-if="coverPending" class="generation-note">
          Save your cover change before generating a spine.
        </p>
        <p class="generation-note">
          {{
            generated
              ? 'Your current preview and the saved cover will be sent to ChatGPT.'
              : 'The saved cover will be sent to ChatGPT. Save a new cover first if you want to use it.'
          }}
          Preview the result and save the book to apply it.
        </p>
      </template>
    </div>
    <div v-if="source" class="crop-controls">
      <div class="controls-heading">
        <div>
          <h3>Adjust image</h3>
          <p>Crop the edges to fit your spine.</p>
        </div>
        <Icon name="lucide:crop" aria-hidden="true" />
      </div>
      <label
        v-for="edge in ['left', 'right', 'top', 'bottom'] as const"
        :key="edge"
        class="crop-control"
      >
        <span class="crop-label"
          ><span>{{ edge }}</span
          ><output>{{ edits[edge] }}%</output></span
        >
        <input
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
        />
      </label>
    </div>
    <div class="editor-footer">
      <p>JPEG, PNG, WebP or AVIF · Up to 10 MB</p>
      <p>
        {{
          changed
            ? 'Save the book to apply these changes.'
            : 'Your original image is kept for later edits.'
        }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.spine-editor {
  width: 100%;
  margin-top: 24px;
  padding: 16px;
  border: 1px solid
    color-mix(in srgb, var(--contrast-border-color) 50%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--sub-alt-color) 42%, var(--bg-color));
  color: var(--contrast-text-color);
}
.empty-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  color: var(--contrast-main-color);
  background: color-mix(in srgb, var(--main-color) 12%, var(--bg-color));
  font-size: 18px;
}
.spine-editor h2,
.controls-heading h3 {
  color: var(--contrast-main-color);
  font-size: 14px;
  font-weight: 650;
}
.controls-heading p {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.75;
}
.spine-error {
  margin-top: 12px;
  padding: 9px 10px;
  border-radius: 8px;
  color: var(--contrast-error-color);
  background: color-mix(in srgb, var(--error-color) 10%, var(--bg-color));
  font-size: 12px;
}
.spine-error button {
  margin-left: 5px;
  text-decoration: underline;
}
.preview-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 188px;
  gap: 9px;
  margin-top: 16px;
  padding: 20px 14px 14px;
  overflow: hidden;
  border: 1px solid
    color-mix(in srgb, var(--contrast-border-color) 35%, transparent);
  border-radius: 10px;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--sub-alt-color) 80%, var(--bg-color)),
    var(--bg-color)
  );
}
.preview-stage.empty {
  border-style: dashed;
  text-align: center;
}
.generation-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: white;
  background: rgb(0 0 0 / 65%);
  font-size: 12px;
  font-weight: 600;
}
.preview-stage.empty strong {
  font-size: 13px;
  color: var(--contrast-main-color);
}
.preview-stage.empty > span:last-child {
  max-width: 210px;
  font-size: 12px;
  opacity: 0.75;
}
.empty-icon {
  width: 42px;
  height: 42px;
}
.crop-preview {
  position: relative;
  max-width: 100%;
  max-height: 280px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--sub-alt-color);
  box-shadow: 0 7px 18px #0003;
}
.crop-preview img {
  position: absolute;
  max-width: none;
  object-fit: fill;
}
.preview-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.7;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 12px;
}
.actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 7px 10px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 8px;
  background: var(--bg-color);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 140ms,
    border-color 140ms;
}
.actions button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--main-color) 10%, var(--bg-color));
  border-color: var(--contrast-main-color);
}
.actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
.actions .upload-action {
  background: var(--main-color);
  border-color: var(--main-color);
  color: var(--contrast-inverse-color);
}
.actions .upload-action:hover:not(:disabled) {
  background: color-mix(in srgb, var(--main-color) 85%, var(--bg-color));
}
.actions .undo-action {
  border-color: transparent;
  background: transparent;
  color: var(--contrast-main-color);
}
.generation {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid
    color-mix(in srgb, var(--contrast-border-color) 40%, transparent);
}
.generation-label {
  display: grid;
  gap: 6px;
  margin-top: 12px;
  font-size: 12px;
}
.generation-label textarea {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 8px;
  background: var(--bg-color);
  resize: vertical;
}
.generation-note {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.8;
}

.spine-editor :is(button, input):focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
}
.crop-controls {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid
    color-mix(in srgb, var(--contrast-border-color) 40%, transparent);
}
.controls-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--contrast-main-color);
}
.crop-control {
  display: block;
  margin-top: 12px;
  font-size: 12px;
}
.crop-label {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.crop-label span {
  text-transform: capitalize;
}
.crop-label output {
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
.crop-control input {
  display: block;
  width: 100%;
  margin-top: 5px;
  accent-color: var(--main-color);
}
.editor-footer {
  display: grid;
  gap: 4px;
  margin-top: 15px;
  font-size: 11px;
  opacity: 0.72;
}
</style>
