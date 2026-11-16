<script setup lang="ts">
import {
  defaultSpineEdits,
  parseSpineEdits,
  type SpineEdits,
} from '~~/shared/spine-artwork';
import type { SeriesSpineReference } from '~~/shared/spine-series-references';
const props = defineProps<{
  bookId: string;
  hasCover: boolean;
  coverPending: boolean;
  open: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;
watch(
  () => props.open,
  async (open) => {
    if (open) {
      previousFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      await nextTick();
      closeButton.value?.focus();
    } else {
      previousFocus?.focus();
      previousFocus = null;
    }
  },
  { flush: 'sync' },
);
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const controls = Array.from(
    dialog.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([type="file"]), textarea:not([disabled]), [tabindex="0"]',
    ) ?? [],
  ).filter((element) => element.getClientRects().length > 0);
  if (!controls.length) return;
  const index = controls.findIndex(
    (element) => element === document.activeElement,
  );
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    controls.at(-1)?.focus();
  } else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) {
    event.preventDefault();
    controls[0]?.focus();
  }
}
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
const zoom = ref(100);
const cropMode = ref(false);
const cropCanvas = ref<HTMLElement | null>(null);
const viewport = ref<HTMLElement | null>(null);
const pan = ref<{
  pointerId: number;
  x: number;
  y: number;
  left: number;
  top: number;
} | null>(null);
const seriesSpines = ref<SeriesSpineReference[]>([]);
const selectedSeriesIds = ref<string[]>([]);
const referencesLoading = ref(true);
const referencesError = ref(false);
type CropEdge = 'left' | 'right' | 'top' | 'bottom';
const cropHandles: { name: string; edges: CropEdge[] }[] = [
  { name: 'top-left', edges: ['top', 'left'] },
  { name: 'top', edges: ['top'] },
  { name: 'top-right', edges: ['top', 'right'] },
  { name: 'right', edges: ['right'] },
  { name: 'bottom-right', edges: ['bottom', 'right'] },
  { name: 'bottom', edges: ['bottom'] },
  { name: 'bottom-left', edges: ['bottom', 'left'] },
  { name: 'left', edges: ['left'] },
];
let drag: {
  pointerId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  initial: SpineEdits;
  edges: CropEdge[];
} | null = null;
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
const sourceAspect = computed(() =>
  dimensions.value ? dimensions.value.width / dimensions.value.height : 1 / 3,
);
const displayAspect = computed(() =>
  cropMode.value ? sourceAspect.value : aspect.value,
);
const displayWidth = computed(() =>
  Math.max(
    1,
    (Math.min(cropMode.value ? 240 : 150, 450 * displayAspect.value) *
      zoom.value) /
      100,
  ),
);
const cropBoxStyle = computed(() => ({
  left: `${edits.value.left}%`,
  right: `${edits.value.right}%`,
  top: `${edits.value.top}%`,
  bottom: `${edits.value.bottom}%`,
}));
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
function zoomWithWheel(event: WheelEvent) {
  if (event.shiftKey || !source.value || !event.deltaY) return;
  event.preventDefault();
  const delta =
    event.deltaY *
    (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
  zoom.value = Math.max(
    50,
    Math.min(800, zoom.value * Math.exp(-delta * 0.002)),
  );
}
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
  cropMode.value = false;
}
function adjustCrop(
  initial: SpineEdits,
  edges: CropEdge[],
  dx: number,
  dy: number,
) {
  const next = { ...initial };
  const clamp = (value: number, opposite: number) =>
    Math.max(
      0,
      Math.min(
        90,
        Math.floor((95 - opposite) * 10 + 0.000001) / 10,
        Math.round(value * 10) / 10,
      ),
    );
  if (edges.includes('left'))
    next.left = clamp(initial.left + dx, initial.right);
  if (edges.includes('right'))
    next.right = clamp(initial.right - dx, initial.left);
  if (edges.includes('top')) next.top = clamp(initial.top + dy, initial.bottom);
  if (edges.includes('bottom'))
    next.bottom = clamp(initial.bottom - dy, initial.top);
  edits.value = next;
}
function startCrop(event: PointerEvent, edges: CropEdge[]) {
  if (event.button !== 0 || props.disabled || busy.value || !cropCanvas.value)
    return;
  const rect = cropCanvas.value.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  drag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    width: rect.width,
    height: rect.height,
    initial: { ...edits.value },
    edges,
  };
  cropCanvas.value.setPointerCapture(event.pointerId);
  event.preventDefault();
}
function moveCrop(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  adjustCrop(
    drag.initial,
    drag.edges,
    ((event.clientX - drag.x) * 100) / drag.width,
    ((event.clientY - drag.y) * 100) / drag.height,
  );
}
function stopCrop(event: PointerEvent) {
  if (drag?.pointerId === event.pointerId) drag = null;
}
function keyCrop(event: KeyboardEvent, edges: CropEdge[]) {
  const amount = event.shiftKey ? 1 : 0.1;
  const dx =
    event.key === 'ArrowRight'
      ? amount
      : event.key === 'ArrowLeft'
        ? -amount
        : 0;
  const dy =
    event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
  if ((!dx && !dy) || props.disabled || busy.value) return;
  event.preventDefault();
  adjustCrop(edits.value, edges, dx, dy);
}
function startPan(event: PointerEvent) {
  const el = viewport.value;
  if (
    !el ||
    event.button !== 0 ||
    event.pointerType === 'touch' ||
    (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)
  )
    return;
  pan.value = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: el.scrollLeft,
    top: el.scrollTop,
  };
  el.setPointerCapture(event.pointerId);
  event.preventDefault();
}
function movePan(event: PointerEvent) {
  const el = viewport.value;
  const active = pan.value;
  if (!el || !active || active.pointerId !== event.pointerId) return;
  el.scrollLeft = active.left - (event.clientX - active.x);
  el.scrollTop = active.top - (event.clientY - active.y);
}
function stopPan(event: PointerEvent) {
  if (pan.value?.pointerId === event.pointerId) pan.value = null;
}
async function loadSeriesSpines() {
  referencesLoading.value = true;
  referencesError.value = false;
  try {
    const refs = await $fetch<SeriesSpineReference[]>(
      `/api/books/${encodeURIComponent(props.bookId)}/spine-generate/series-references`,
    );
    seriesSpines.value = refs;
    selectedSeriesIds.value = refs.map((item) => item.bookId);
  } catch {
    seriesSpines.value = [];
    selectedSeriesIds.value = [];
    referencesError.value = true;
  } finally {
    referencesLoading.value = false;
  }
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
    body.append(
      'seriesReferences',
      JSON.stringify(
        seriesSpines.value
          .filter((item) => selectedSeriesIds.value.includes(item.bookId))
          .map(({ bookId, revision }) => ({ bookId, revision })),
      ),
    );
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
  loadSeriesSpines();
});
onBeforeUnmount(() => {
  selection++;
  clearFile();
});
defineExpose({
  save,
  reset,
  busy,
  generating,
  source,
  previewStyle,
  aspect,
  imageLoaded,
});
</script>

<template>
  <ModalWindow :open="open" :width-full="true" @close="emit('close')">
    <section
      ref="dialog"
      class="spine-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="spine-dialog-title"
      @keydown="trapFocus"
    >
      <header class="spine-dialog-header">
        <div>
          <h2 id="spine-dialog-title">Edit spine</h2>
          <p>Changes apply when you save the book.</p>
        </div>
        <button
          ref="closeButton"
          type="button"
          aria-label="Close spine editor"
          @click="emit('close')"
        >
          <Icon name="lucide:x" aria-hidden="true" />
        </button>
      </header>
      <div class="spine-layout">
        <div class="spine-preview-column">
          <div
            class="preview-stage"
            :class="{ empty: !source }"
            @wheel="zoomWithWheel"
          >
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
                ref="viewport"
                class="preview-viewport"
                :class="{ panning: pan }"
                tabindex="0"
                aria-label="Spine image viewport. Drag to pan when zoomed."
                @pointerdown="startPan"
                @pointermove="movePan"
                @pointerup="stopPan"
                @pointercancel="stopPan"
                @lostpointercapture="stopPan"
              >
                <div
                  v-if="cropMode"
                  ref="cropCanvas"
                  class="crop-canvas"
                  :style="{
                    aspectRatio: String(sourceAspect),
                    width: `${displayWidth}px`,
                  }"
                  @pointermove="moveCrop"
                  @pointerup="stopCrop"
                  @pointercancel="stopCrop"
                >
                  <img
                    :src="source"
                    alt="Spine image with crop handles"
                    @load="imageLoaded"
                    @error="error = 'Could not load the spine preview.'"
                  />
                  <div class="crop-mask" aria-hidden="true">
                    <div class="crop-mask-selection" :style="cropBoxStyle" />
                  </div>
                  <div class="crop-selection" :style="cropBoxStyle">
                    <button
                      v-for="handle in cropHandles"
                      :key="handle.name"
                      type="button"
                      class="crop-handle"
                      :class="`handle-${handle.name}`"
                      :aria-label="`Drag ${handle.name} crop handle`"
                      :disabled="disabled || busy"
                      @pointerdown.stop="startCrop($event, handle.edges)"
                      @keydown="keyCrop($event, handle.edges)"
                    />
                  </div>
                </div>
                <div
                  v-else
                  class="crop-preview"
                  :style="{
                    aspectRatio: String(aspect),
                    width: `${displayWidth}px`,
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
              <span class="preview-label">{{
                cropMode
                  ? 'Drag handles to crop · Drag image to pan'
                  : 'Drag image to pan'
              }}</span>
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
          <div v-if="source" class="preview-tools">
            <button
              type="button"
              :disabled="disabled || busy"
              @click="cropMode = !cropMode"
            >
              {{ cropMode ? 'Done cropping' : 'Crop image' }}
            </button>
            <div class="zoom-controls" aria-label="Spine preview zoom">
              <button
                type="button"
                aria-label="Zoom out"
                :disabled="zoom <= 50"
                @click="zoom = Math.max(50, zoom - 25)"
              >
                <Icon name="lucide:minus" aria-hidden="true" />
              </button>
              <button type="button" aria-label="Reset zoom" @click="zoom = 100">
                {{ Math.round(zoom) }}%
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                :disabled="zoom >= 800"
                @click="zoom = Math.min(800, zoom + 25)"
              >
                <Icon name="lucide:plus" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        <div class="spine-control-column">
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
              Spine generation is not configured. Ask an administrator to
              connect ChatGPT in Admin settings.
            </p>
            <template v-else>
              <div v-if="referencesLoading" class="generation-note">
                Looking for other spines in the saved series…
              </div>
              <div v-else-if="referencesError" class="generation-note">
                Could not load series spines.
                <button
                  type="button"
                  class="reference-retry"
                  @click="loadSeriesSpines"
                >
                  Try again</button
                >, or generate without them.
              </div>
              <fieldset
                v-else-if="seriesSpines.length"
                class="series-references"
              >
                <legend>Match other spines in this series</legend>
                <p>
                  Selected spines from the saved series will be sent to ChatGPT
                  as visual references.
                </p>
                <label
                  v-for="item in seriesSpines"
                  :key="item.bookId"
                  class="series-reference"
                >
                  <input
                    v-model="selectedSeriesIds"
                    type="checkbox"
                    :value="item.bookId"
                    :disabled="disabled || busy"
                  />
                  <img
                    :src="`/api/books/${encodeURIComponent(item.bookId)}/spine?v=${encodeURIComponent(item.revision)}`"
                    alt=""
                  />
                  <span
                    >{{ item.title
                    }}<small v-if="item.seriesIndex !== null"
                      >Book {{ item.seriesIndex }}</small
                    ></span
                  >
                </label>
                <button
                  type="button"
                  class="reference-retry"
                  :disabled="disabled || busy"
                  @click="loadSeriesSpines"
                >
                  Refresh series spines
                </button>
              </fieldset>
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
                  :disabled="
                    disabled ||
                    busy ||
                    !hasCover ||
                    coverPending ||
                    referencesLoading
                  "
                  @click="generate"
                >
                  <Icon
                    :name="
                      generating ? 'lucide:loader-circle' : 'lucide:sparkles'
                    "
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
        </div>
      </div>
      <div class="spine-dialog-footer">
        <button type="button" @click="emit('close')">Done</button>
      </div>
    </section>
  </ModalWindow>
</template>

<style scoped>
.spine-editor {
  width: 100%;
  height: min(760px, calc(100dvh - 4rem));
  max-height: calc(100dvh - 4rem);
  display: flex;
  flex-direction: column;
  color: var(--contrast-text-color);
}
.spine-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--contrast-border-color);
}
.spine-dialog-header h2 {
  font-size: 20px;
}
.spine-dialog-header p {
  margin-top: 3px;
  font-size: 12px;
  opacity: 0.75;
}
.spine-dialog-header button {
  padding: 4px;
  font-size: 20px;
}
.spine-layout {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 20px;
  min-height: 0;
  overflow: hidden;
}
.spine-preview-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.spine-control-column {
  padding: 4px 3px 12px;
  overflow: auto;
}
.spine-dialog-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid var(--contrast-border-color);
}
.spine-dialog-footer button {
  padding: 8px 16px;
  border-radius: 7px;
  background: var(--main-color);
  color: var(--contrast-inverse-color);
}
@media (max-width: 640px) {
  .spine-editor {
    height: auto;
  }
  .spine-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto;
    gap: 0;
    overflow: auto;
  }
  .spine-preview-column {
    height: min(500px, max(240px, calc(100dvh - 14rem)));
  }
  .spine-control-column {
    overflow: visible;
  }
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
  flex: 1;
  min-height: 0;
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
.preview-viewport {
  display: flex;
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 16px;
  overflow: auto;
  cursor: grab;
  user-select: none;
}
.preview-viewport.panning {
  cursor: grabbing;
}
.crop-preview,
.crop-canvas {
  position: relative;
  flex: none;
  margin: auto;
  border-radius: 3px;
  background: var(--sub-alt-color);
  box-shadow: 0 7px 18px #0003;
}
.crop-preview {
  overflow: hidden;
}
.crop-preview img {
  position: absolute;
  max-width: none;
  object-fit: fill;
}
.crop-canvas img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  border-radius: inherit;
  pointer-events: none;
}
.crop-mask {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}
.crop-mask-selection {
  position: absolute;
  box-shadow: 0 0 0 9999px rgb(0 0 0 / 55%);
}
.crop-selection {
  position: absolute;
  border: 1px solid white;
  pointer-events: none;
}
.crop-handle {
  position: absolute;
  width: 28px;
  height: 28px;
  border: 0;
  background: transparent;
  pointer-events: auto;
  touch-action: none;
}
.crop-handle::before {
  content: '';
  position: absolute;
  filter: drop-shadow(0 0 1px #000);
}
.handle-top-left {
  top: -14px;
  left: -14px;
  cursor: nwse-resize;
}
.handle-top-left::before {
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-top: 3px solid white;
  border-left: 3px solid white;
}
.handle-top {
  top: -18px;
  left: 50%;
  transform: translateX(-50%);
  cursor: ns-resize;
}
.handle-top::before,
.handle-bottom::before {
  left: 3px;
  width: 22px;
  height: 4px;
  background: white;
}
.handle-top::before {
  top: 5px;
}
.handle-top-right {
  top: -14px;
  right: -14px;
  cursor: nesw-resize;
}
.handle-top-right::before {
  top: 2px;
  right: 2px;
  width: 13px;
  height: 13px;
  border-top: 3px solid white;
  border-right: 3px solid white;
}
.handle-right {
  top: 50%;
  right: -18px;
  transform: translateY(-50%);
  cursor: ew-resize;
}
.handle-left::before,
.handle-right::before {
  top: 3px;
  width: 4px;
  height: 22px;
  background: white;
}
.handle-right::before {
  right: 5px;
}
.handle-bottom-right {
  bottom: -14px;
  right: -14px;
  cursor: nwse-resize;
}
.handle-bottom-right::before {
  bottom: 2px;
  right: 2px;
  width: 13px;
  height: 13px;
  border-bottom: 3px solid white;
  border-right: 3px solid white;
}
.handle-bottom {
  bottom: -18px;
  left: 50%;
  transform: translateX(-50%);
  cursor: ns-resize;
}
.handle-bottom::before {
  bottom: 5px;
}
.handle-bottom-left {
  bottom: -14px;
  left: -14px;
  cursor: nesw-resize;
}
.handle-bottom-left::before {
  bottom: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-bottom: 3px solid white;
  border-left: 3px solid white;
}
.handle-left {
  top: 50%;
  left: -18px;
  transform: translateY(-50%);
  cursor: ew-resize;
}
.handle-left::before {
  left: 5px;
}
.preview-tools,
.zoom-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.preview-tools {
  justify-content: space-between;
  margin: 10px 0 12px;
}
.preview-tools button {
  min-height: 32px;
  padding: 5px 8px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 7px;
  background: var(--bg-color);
  font-size: 12px;
}
.preview-tools button:disabled {
  opacity: 0.5;
}
.zoom-controls button {
  min-width: 32px;
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
.series-references {
  display: grid;
  gap: 7px;
  margin-top: 12px;
  font-size: 12px;
}
.series-references legend {
  font-weight: 650;
}
.series-references p {
  opacity: 0.75;
}
.series-reference {
  display: flex;
  align-items: center;
  gap: 8px;
}
.series-reference img {
  width: 20px;
  height: 50px;
  object-fit: contain;
  background: var(--bg-color);
}
.series-reference small {
  display: block;
  opacity: 0.7;
}
.reference-retry {
  text-decoration: underline;
  text-align: left;
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
.editor-footer {
  display: grid;
  gap: 4px;
  margin-top: 15px;
  font-size: 11px;
  opacity: 0.72;
}
</style>
