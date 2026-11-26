<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import ModalWindow from '~/components/ModalWindow.vue';
import { useShareCardStore } from '~/stores/shareCard';
import { $fetch } from '~/utils/apiFetch';
import { buildBookCoverUrl } from '~/utils/covers';
import {
  canCopyImage,
  canShareFiles,
  copyPng,
  downloadPng,
  sharePng,
} from '~/utils/shareCardExport';
import { formatSize } from '~/utils/shareCardLayout';
import {
  availableShareCardToggles,
  buildShareCardModel,
  DEFAULT_SHARE_CARD_TOGGLES,
  SHARE_CARD_BACKGROUNDS,
  SHARE_CARD_FORMATS,
  SHARE_CARD_PRESETS,
  shareCardFileName,
  type FinishSummary,
  type ShareCardBackground,
  type ShareCardFormat,
  type ShareCardPreset,
  type ShareCardToggles,
} from '~/utils/shareCardModel';
import {
  paletteFromHex,
  paletteFromPixels,
  type CardPalette,
} from '~/utils/shareCardPalette';
import {
  isTransparentCard,
  renderShareCard,
  SHARE_CARD_FONTS,
  type ShareCardCover,
  type ShareCardTheme,
} from '~/utils/shareCardRender';

const store = useShareCardStore();

const loading = ref(false);
const loadError = ref<string | null>(null);
const summary = shallowRef<FinishSummary | null>(null);
const cover = shallowRef<ShareCardCover | null>(null);
const palette = shallowRef<CardPalette>(paletteFromHex(null));
const theme = shallowRef<ShareCardTheme>(readTheme());
const ready = ref(false);

const preset = ref<ShareCardPreset>('coverPalette');
const format = ref<ShareCardFormat>('square');
const background = ref<ShareCardBackground>('theme');
const toggles = ref<ShareCardToggles>({ ...DEFAULT_SHARE_CARD_TOGGLES });

const canvas = ref<HTMLCanvasElement | null>(null);
const busy = ref<'download' | 'copy' | 'share' | null>(null);
const actionMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const copySupported = canCopyImage();
const shareSupported = canShareFiles();

const open = computed(() => store.openBookId != null);
const size = computed(() => formatSize(format.value));
const available = computed<ShareCardToggles>(() =>
  summary.value
    ? availableShareCardToggles(summary.value)
    : { ...DEFAULT_SHARE_CARD_TOGGLES },
);
const presetDrawsChart = computed(
  () =>
    SHARE_CARD_PRESETS.find((p) => p.value === preset.value)?.chart ?? false,
);
const effectiveToggles = computed<ShareCardToggles>(() => ({
  rating: toggles.value.rating && available.value.rating,
  duration: toggles.value.duration && available.value.duration,
  pages: toggles.value.pages && available.value.pages,
  chart: toggles.value.chart && available.value.chart && presetDrawsChart.value,
  logo: toggles.value.logo,
}));
const model = computed(() =>
  summary.value
    ? buildShareCardModel(summary.value, effectiveToggles.value)
    : null,
);
const transparent = computed(() =>
  isTransparentCard({ preset: preset.value, background: background.value }),
);

const toggleRows = computed(() => {
  const s = summary.value;
  const a = available.value;
  return [
    {
      key: 'rating' as const,
      label: 'Rating',
      disabled: !a.rating,
      hint: a.rating ? null : 'No rating yet',
    },
    {
      key: 'duration' as const,
      label: 'Duration & dates',
      disabled: !a.duration,
      hint: !a.duration
        ? 'No finish date'
        : s?.startedDate
          ? null
          : 'No start date, so no duration',
    },
    {
      key: 'pages' as const,
      label: 'Page count & pace',
      disabled: !a.pages,
      hint: !a.pages
        ? 'No page count'
        : s?.startedDate
          ? null
          : 'No start date, so no pace',
    },
    {
      key: 'chart' as const,
      label: 'Pace chart',
      disabled: !presetDrawsChart.value || !a.chart,
      hint: !presetDrawsChart.value
        ? 'Not used by this style'
        : a.chart
          ? null
          : 'Needs progress logged on 3 or more days',
    },
    { key: 'logo' as const, label: 'Delb logo', disabled: false, hint: null },
  ];
});

function setToggle(key: keyof ShareCardToggles, value: boolean) {
  toggles.value = { ...toggles.value, [key]: value };
}

function readTheme(): ShareCardTheme {
  const fallback = {
    bg: '#1f2023',
    text: '#e9ecf0',
    accent: '#d9775a',
    muted: '#939eae',
  };
  if (typeof document === 'undefined') return fallback;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, value: string) =>
    style.getPropertyValue(name).trim() || value;
  return {
    bg: read('--bg-color', fallback.bg),
    text: read('--text-color', fallback.text),
    accent: read('--main-color', fallback.accent),
    muted: read('--sub-color', fallback.muted),
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Cover failed to load'));
    img.src = src;
  });
}

function samplePixels(img: HTMLImageElement): Uint8ClampedArray | null {
  try {
    const c = document.createElement('canvas');
    c.width = 36;
    c.height = 54;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  } catch {
    // A cross-origin cover would taint the canvas; fall back to the theme.
    return null;
  }
}

async function loadFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  await Promise.all(
    SHARE_CARD_FONTS.map((f) => document.fonts.load(f).catch(() => [])),
  );
}

let loadToken = 0;
async function load(bookId: string) {
  const token = ++loadToken;
  loading.value = true;
  ready.value = false;
  loadError.value = null;
  summary.value = null;
  cover.value = null;
  actionMessage.value = null;
  actionError.value = null;
  theme.value = readTheme();
  try {
    const res = await $fetch<{ success: boolean; data: FinishSummary }>(
      `/api/books/${encodeURIComponent(bookId)}/finish-summary`,
    );
    if (token !== loadToken) return;
    const data = res.data;
    summary.value = data;
    toggles.value = { ...DEFAULT_SHARE_CARD_TOGGLES };

    let pixels: Uint8ClampedArray | null = null;
    if (data.book.coverImagePath) {
      try {
        const img = await loadImage(
          buildBookCoverUrl({
            bookId: data.book.id,
            variant: 'source',
            updatedAt: data.book.updatedAt,
          }),
        );
        if (token !== loadToken) return;
        cover.value = {
          image: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
        pixels = samplePixels(img);
      } catch {
        cover.value = null;
      }
    }
    palette.value = pixels
      ? paletteFromPixels(pixels)
      : paletteFromHex(
          theme.value.accent.startsWith('#') ? theme.value.accent : null,
        );
    await loadFonts();
    if (token !== loadToken) return;
    ready.value = true;
  } catch (err) {
    if (token !== loadToken) return;
    const e = err as { data?: { message?: string }; message?: string };
    loadError.value =
      e?.data?.message || e?.message || 'Failed to load the share card.';
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(
  () => store.openBookId,
  (id) => {
    if (id) void load(id);
    else {
      loadToken++;
      ready.value = false;
    }
  },
  { immediate: true },
);

function draw() {
  const el = canvas.value;
  const m = model.value;
  if (!el || !m || !ready.value) return;
  const { width, height } = size.value;
  if (el.width !== width) el.width = width;
  if (el.height !== height) el.height = height;
  const ctx = el.getContext('2d');
  if (!ctx) return;
  renderShareCard(ctx, m, {
    preset: preset.value,
    format: format.value,
    background: background.value,
    palette: palette.value,
    theme: theme.value,
    cover: cover.value,
  });
}

watch(
  [model, preset, format, background, palette, cover, ready, canvas],
  async () => {
    await nextTick();
    draw();
  },
  { flush: 'post' },
);

const fileName = computed(() =>
  shareCardFileName(summary.value?.book.title ?? 'book', format.value),
);

async function runAction(
  kind: 'download' | 'copy' | 'share',
  fn: (el: HTMLCanvasElement) => Promise<string | null>,
) {
  const el = canvas.value;
  if (!el || busy.value) return;
  busy.value = kind;
  actionMessage.value = null;
  actionError.value = null;
  try {
    draw();
    actionMessage.value = await fn(el);
  } catch (err) {
    actionError.value =
      (err as Error)?.message || 'Something went wrong. Please try again.';
  } finally {
    busy.value = null;
  }
}

function onDownload() {
  void runAction('download', async (el) => {
    await downloadPng(el, fileName.value);
    return 'Saved the PNG.';
  });
}

function onCopy() {
  void runAction('copy', async (el) => {
    await copyPng(el);
    return 'Copied the image.';
  });
}

function onShare() {
  void runAction('share', async (el) => {
    const shared = await sharePng(
      el,
      fileName.value,
      summary.value?.book.title ?? 'Finished book',
    );
    return shared ? 'Shared.' : null;
  });
}

function close() {
  store.close();
}
</script>

<template>
  <ModalWindow :open="open" width-full @close="close">
    <div
      class="flex flex-col gap-4 max-h-[calc(100dvh-4rem)] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-card-title"
    >
      <div class="flex items-center justify-between gap-2">
        <h2 id="share-card-title" class="text-lg font-semibold">Share card</h2>
        <button
          type="button"
          class="p-1 rounded-md hover:bg-(--sub-alt-color)"
          aria-label="Close"
          @click="close"
        >
          <Icon name="lucide:x" class="w-5 h-5" />
        </button>
      </div>

      <p v-if="loading" role="status" class="opacity-70">
        Preparing your card...
      </p>
      <p
        v-else-if="loadError"
        role="alert"
        class="text-(--contrast-error-color)"
      >
        {{ loadError }}
      </p>

      <div
        v-show="ready && !loadError"
        class="grid gap-5 md:grid-cols-[minmax(0,1fr)_17rem]"
      >
        <div
          class="flex items-center justify-center rounded-lg p-3 min-h-[240px] bg-(--sub-alt-color)"
          :class="transparent ? 'share-card-checker' : ''"
        >
          <canvas
            ref="canvas"
            :width="size.width"
            :height="size.height"
            class="block max-w-full max-h-[62dvh] w-auto h-auto rounded-md shadow-lg"
            :style="{ aspectRatio: `${size.width} / ${size.height}` }"
            role="img"
            :aria-label="`Share card preview for ${summary?.book.title ?? 'this book'}`"
          />
        </div>

        <div class="flex flex-col gap-4 text-sm">
          <fieldset class="flex flex-col gap-1.5">
            <legend class="font-semibold mb-1">Style</legend>
            <div class="grid grid-cols-2 gap-1.5">
              <button
                v-for="p in SHARE_CARD_PRESETS"
                :key="p.value"
                type="button"
                class="px-2 py-1.5 rounded-md border text-left"
                :class="
                  preset === p.value
                    ? 'border-(--contrast-main-color) text-(--contrast-main-color)'
                    : 'border-(--contrast-border-color)'
                "
                :aria-pressed="preset === p.value"
                @click="preset = p.value"
              >
                {{ p.label }}
              </button>
            </div>
          </fieldset>

          <fieldset class="flex flex-col gap-1.5">
            <legend class="font-semibold mb-1">Format</legend>
            <div class="flex gap-1.5">
              <button
                v-for="f in SHARE_CARD_FORMATS"
                :key="f.value"
                type="button"
                class="flex-1 px-2 py-1.5 rounded-md border"
                :class="
                  format === f.value
                    ? 'border-(--contrast-main-color) text-(--contrast-main-color)'
                    : 'border-(--contrast-border-color)'
                "
                :aria-pressed="format === f.value"
                :title="`${f.width} × ${f.height}`"
                @click="format = f.value"
              >
                {{ f.label }}
              </button>
            </div>
          </fieldset>

          <fieldset
            v-if="preset === 'paceOverlay'"
            class="flex flex-col gap-1.5"
          >
            <legend class="font-semibold mb-1">Background</legend>
            <div class="flex gap-1.5">
              <button
                v-for="b in SHARE_CARD_BACKGROUNDS"
                :key="b.value"
                type="button"
                class="flex-1 px-2 py-1.5 rounded-md border"
                :class="
                  background === b.value
                    ? 'border-(--contrast-main-color) text-(--contrast-main-color)'
                    : 'border-(--contrast-border-color)'
                "
                :aria-pressed="background === b.value"
                @click="background = b.value"
              >
                {{ b.label }}
              </button>
            </div>
            <p v-if="background === 'transparent'" class="text-xs opacity-70">
              The PNG has no background, so you can place it over a photo.
            </p>
          </fieldset>

          <fieldset class="flex flex-col gap-1">
            <legend class="font-semibold mb-1">Show</legend>
            <label
              v-for="row in toggleRows"
              :key="row.key"
              class="flex items-start gap-2 py-0.5"
              :class="row.disabled ? 'opacity-60' : ''"
            >
              <input
                type="checkbox"
                class="mt-0.5"
                :checked="toggles[row.key] && !row.disabled"
                :disabled="row.disabled"
                @change="
                  setToggle(
                    row.key,
                    ($event.target as HTMLInputElement).checked,
                  )
                "
              />
              <span class="flex flex-col">
                <span>{{ row.label }}</span>
                <span v-if="row.hint" class="text-xs opacity-80">{{
                  row.hint
                }}</span>
              </span>
            </label>
          </fieldset>

          <div class="flex flex-col gap-2">
            <button
              type="button"
              class="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-(--main-color) text-(--contrast-inverse-color) disabled:opacity-60"
              :disabled="!ready || busy !== null"
              @click="onDownload"
            >
              <Icon name="lucide:download" class="w-4 h-4" />
              Download PNG
            </button>
            <div class="flex gap-2">
              <button
                v-if="copySupported"
                type="button"
                class="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-(--contrast-border-color) disabled:opacity-60"
                :disabled="!ready || busy !== null"
                @click="onCopy"
              >
                <Icon name="lucide:copy" class="w-4 h-4" />
                Copy image
              </button>
              <button
                v-if="shareSupported"
                type="button"
                class="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-(--contrast-border-color) disabled:opacity-60"
                :disabled="!ready || busy !== null"
                @click="onShare"
              >
                <Icon name="lucide:share-2" class="w-4 h-4" />
                Share
              </button>
            </div>
            <p
              v-if="actionMessage"
              role="status"
              class="text-xs text-(--contrast-main-color)"
            >
              {{ actionMessage }}
            </p>
            <p
              v-if="actionError"
              role="alert"
              class="text-xs text-(--contrast-error-color)"
            >
              {{ actionError }}
            </p>
            <p class="text-xs opacity-70">
              The image has no link to your library. Reviews and notes are never
              included.
            </p>
          </div>
        </div>
      </div>
    </div>
  </ModalWindow>
</template>

<style scoped>
.share-card-checker {
  background-color: #8a8a8a;
  background-image:
    linear-gradient(45deg, #b4b4b4 25%, transparent 25%),
    linear-gradient(-45deg, #b4b4b4 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #b4b4b4 75%),
    linear-gradient(-45deg, transparent 75%, #b4b4b4 75%);
  background-size: 20px 20px;
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
}
</style>
