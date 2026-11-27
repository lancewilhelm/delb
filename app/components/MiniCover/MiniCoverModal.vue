<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue';
import ModalWindow from '~/components/ModalWindow.vue';
import { useMiniCoverStore } from '~/stores/miniCover';
import { $fetch } from '~/utils/apiFetch';
import {
  fetchBookDetail,
  invalidateBookDetail,
} from '~/utils/bookPreviewCache';
import { buildBookCoverUrl } from '~/utils/covers';
import {
  buildSpineEditsForSave,
  FULL_CROP_INSETS,
  layoutMiniCover,
  MINI_COVER_BLEEDS,
  MINI_COVER_MM,
  MINI_COVER_RESOLUTIONS,
  miniCoverFileName,
  resolutionConfig,
  suggestOneToThreeCrop,
  type CropInsets,
  type MiniCoverBackStyle,
  type MiniCoverBleedMm,
  type MiniCoverOrientation,
  type MiniCoverResolution,
  type MiniCoverSpineFit,
} from '~/utils/miniCoverLayout';
import {
  renderMiniCover,
  sampleEdgeColor,
  type MiniCoverImageSource,
} from '~/utils/miniCoverRender';
import { canvasToPhysicalPngBlob, downloadPngBlob } from '~/utils/pngPhys';
import { canCopyImage } from '~/utils/shareCardExport';
import {
  paletteFromHex,
  paletteFromPixels,
  type CardPalette,
} from '~/utils/shareCardPalette';
import {
  MINI_COVER_SPINE_RATIO,
  spineRatioStatus,
} from '~~/shared/spine-artwork';
import {
  MAX_SERIES_SPINE_REFERENCES,
  type SeriesSpineReference,
} from '~~/shared/spine-series-references';

type BookSummary = {
  id: string;
  title: string;
  coverImagePath?: string | null;
  spineRevision?: string | null;
  updatedAt?: string | number | Date;
  canEdit?: boolean;
  authors?: { id: string; name: string }[];
};

type SpineSourceKind = 'saved' | 'uploaded' | 'generated' | 'plain';
type PreviewMode = 'flat' | 'folded';
type CropEdge = 'left' | 'right' | 'top' | 'bottom';

type StagedSpineAsset = {
  file: File;
  url: string;
  image: HTMLImageElement;
  width: number;
  height: number;
  edgeColor: string | null;
  crop: CropInsets;
};

const store = useMiniCoverStore();

const dialog = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const filePicker = ref<HTMLInputElement | null>(null);
const trimCanvasRef = ref<HTMLElement | null>(null);
const generateSectionRef = ref<HTMLElement | null>(null);
const uploadButtonRef = ref<HTMLButtonElement | null>(null);

let previousFocus: HTMLElement | null = null;
let loadToken = 0;

const open = computed(() => store.openBookId != null);

// Loaded book + assets
const loading = ref(false);
const loadError = ref<string | null>(null);
const book = shallowRef<BookSummary | null>(null);
const coverAsset = shallowRef<MiniCoverImageSource | null>(null);
const coverFailed = ref(false);
const palette = shallowRef<CardPalette>(paletteFromHex(null));

// Saved spine
const savedSpineRevision = ref<string | null>(null);
const savedSpineAsset = shallowRef<MiniCoverImageSource | null>(null);
const savedSpineError = ref<string | null>(null);

// Local uploaded & generated spines (session-scoped unless saved to book)
const uploadedSpine = shallowRef<StagedSpineAsset | null>(null);
const generatedSpine = shallowRef<StagedSpineAsset | null>(null);
const spineSource = ref<SpineSourceKind>('plain');
const spineFit = ref<MiniCoverSpineFit>('crop');
const spineOffset = ref(0);

// Inline trim mode for uploaded/generated spines
const trimMode = ref(false);
const trimLockRatio = ref(true);
const trimDraft = ref<CropInsets>({ ...FULL_CROP_INSETS });
let trimDrag: {
  pointerId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  initial: CropInsets;
  edges: CropEdge[];
} | null = null;

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

// Spine generation (editors + ChatGPT connected)
const canEdit = computed(() => Boolean(book.value?.canEdit));
const hasCover = computed(() => Boolean(book.value?.coverImagePath));
const connection = ref(false);
const connectionChecked = ref(false);
const seriesSpines = ref<SeriesSpineReference[]>([]);
const selectedSeriesIds = ref<string[]>([]);
const referencesLoading = ref(false);
const referencesError = ref(false);
const instructions = ref('');
const generating = ref(false);
const spineError = ref<string | null>(null);

// Save-to-book flow (editors only)
const saveConfirmOpen = ref(false);
const savingToBook = ref(false);
const saveStatusMessage = ref<string | null>(null);
const saveConflict = ref(false);

// Cover & layout options
const backStyle = ref<MiniCoverBackStyle>('same');
const orientation = ref<MiniCoverOrientation>('ltr');
const resolution = ref<MiniCoverResolution>('high');
const bleedMm = ref<MiniCoverBleedMm>(0);
const foldMarks = ref(true);
const trimMarks = ref(false);

// Preview presentation state
const previewMode = ref<PreviewMode>('flat');
const showGuides = ref(true);
const actualSize = ref(false);
const zoom = ref(100);
const foldedDataUrl = ref<string | null>(null);
const foldedYaw = ref(-20);
let foldDrag: { pointerId: number; x: number; startYaw: number } | null = null;
let spinePanDrag: {
  pointerId: number;
  x: number;
  y: number;
  startOffset: number;
  axis: 'x' | 'y';
  spanPx: number;
} | null = null;

// Export action state
const exportBusy = ref<'download' | 'copy' | null>(null);
const actionMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const copySupported = canCopyImage();

const ONE_TO_THREE_PROMPT_PREFIX =
  'Re-lay out this spine at exactly 1:3 width-to-height proportions (10×30 mm) with clean edges, keeping its typography, artwork, and color palette readable within the 1:3 frame.';

const authorText = computed(() =>
  (book.value?.authors ?? [])
    .map((a) => a.name)
    .filter(Boolean)
    .join(', '),
);

const resInfo = computed(() => resolutionConfig(resolution.value));
const effectiveTrimMarks = computed(() => bleedMm.value > 0 && trimMarks.value);

const layout = computed(() =>
  layoutMiniCover({
    pxPerMm: resInfo.value.pxPerMm,
    bleedMm: bleedMm.value,
    trimMarks: effectiveTrimMarks.value,
    orientation: orientation.value,
  }),
);

const activeStagedAsset = computed<StagedSpineAsset | null>(() => {
  if (spineSource.value === 'uploaded') return uploadedSpine.value;
  if (spineSource.value === 'generated') return generatedSpine.value;
  return null;
});

const activeSpineImage = computed<MiniCoverImageSource | null>(() => {
  if (spineSource.value === 'saved') return savedSpineAsset.value;
  if (spineSource.value === 'uploaded') {
    const a = uploadedSpine.value;
    return a
      ? {
          image: a.image,
          width: a.width,
          height: a.height,
          edgeColor: a.edgeColor,
        }
      : null;
  }
  if (spineSource.value === 'generated') {
    const a = generatedSpine.value;
    return a
      ? {
          image: a.image,
          width: a.width,
          height: a.height,
          edgeColor: a.edgeColor,
        }
      : null;
  }
  return null;
});

const activeSpineCrop = computed<CropInsets>(() => {
  return activeStagedAsset.value?.crop ?? FULL_CROP_INSETS;
});

/** Effective cropped dimensions of the currently active spine image. */
const activeSpineEffectiveDims = computed<{
  width: number;
  height: number;
} | null>(() => {
  const img = activeSpineImage.value;
  if (!img) return null;
  const c = activeSpineCrop.value;
  const w = (img.width * (100 - c.left - c.right)) / 100;
  const h = (img.height * (100 - c.top - c.bottom)) / 100;
  return w > 0 && h > 0 ? { width: w, height: h } : null;
});

const spineRatio = computed(() => {
  const dims = activeSpineEffectiveDims.value;
  return dims ? spineRatioStatus(dims.width, dims.height) : null;
});

const showFitControls = computed(
  () =>
    spineSource.value !== 'plain' &&
    activeSpineImage.value !== null &&
    spineRatio.value !== null &&
    spineRatio.value.state !== 'fit',
);

const canDragSpineOffset = computed(
  () =>
    previewMode.value === 'flat' &&
    !trimMode.value &&
    showFitControls.value &&
    spineFit.value === 'crop',
);

const coverRatioNote = computed(() => {
  const c = coverAsset.value;
  if (!c) return null;
  const r = c.width / c.height;
  const target = 2 / 3;
  const dev = Math.abs(r - target) / target;
  if (dev <= 0.04) return null;
  return 'The cover is slightly different from 2:3 and will be center-cropped to fill 20 × 30 mm.';
});

const lowResWarning = computed(() => {
  const notes: string[] = [];
  const spineTargetW = layout.value.panels.spine.w;
  const spineTargetH = layout.value.panels.spine.h;
  const dims = activeSpineEffectiveDims.value;
  if (
    dims &&
    (dims.width < spineTargetW * 0.9 || dims.height < spineTargetH * 0.9)
  ) {
    notes.push(
      `The active spine is ${Math.round(dims.width)} × ${Math.round(dims.height)} px; at ${resInfo.value.label.toLowerCase()} it will be enlarged slightly.`,
    );
  }
  const cover = coverAsset.value;
  const coverTargetW = layout.value.panels.front.w;
  const coverTargetH = layout.value.panels.front.h;
  if (
    cover &&
    (cover.width < coverTargetW * 0.9 || cover.height < coverTargetH * 0.9)
  ) {
    notes.push(
      `The cover image is ${cover.width} × ${cover.height} px and will be scaled to ${coverTargetW} × ${coverTargetH} px.`,
    );
  }
  return notes.join(' ');
});

const seriesSelectionLimit = computed(
  () =>
    MAX_SERIES_SPINE_REFERENCES -
    (hasReferenceSpineForGeneration.value ? 1 : 0),
);

const hasReferenceSpineForGeneration = computed(
  () =>
    activeSpineImage.value !== null ||
    savedSpineAsset.value !== null ||
    generatedSpine.value !== null ||
    uploadedSpine.value !== null,
);

const hasUnsavedLocalSpine = computed(
  () =>
    (spineSource.value === 'uploaded' && Boolean(uploadedSpine.value)) ||
    (spineSource.value === 'generated' && Boolean(generatedSpine.value)),
);

const subtitleText = computed(() =>
  orientation.value === 'ltr'
    ? `${MINI_COVER_MM.totalWidth} × ${MINI_COVER_MM.height} mm wrap · cover (20 mm), spine (10 mm), cover (20 mm)`
    : `${MINI_COVER_MM.totalWidth} × ${MINI_COVER_MM.height} mm wrap · front (20 mm), spine (10 mm), back (20 mm)`,
);

const fileName = computed(() =>
  miniCoverFileName(book.value?.title ?? 'book', resolution.value),
);

// CSS pixel width for preview canvas
const flatPreviewWidthStyle = computed(() => {
  if (actualSize.value) {
    // 1 mm = 96 / 25.4 CSS px
    const totalMm =
      MINI_COVER_MM.totalWidth + bleedMm.value * 2 + layout.value.marginMm * 2;
    return `${Math.round((totalMm * 96) / 25.4)}px`;
  }
  return `${Math.round((460 * zoom.value) / 100)}px`;
});

// Percentage coordinates for SVG guide overlay inside the preview wrap
const guidePercents = computed(() => {
  const l = layout.value;
  return {
    trimLeft: (l.trimRect.x / l.width) * 100,
    trimTop: (l.trimRect.y / l.height) * 100,
    trimWidth: (l.trimRect.w / l.width) * 100,
    trimHeight: (l.trimRect.h / l.height) * 100,
    fold1: (l.folds[0] / l.width) * 100,
    fold2: (l.folds[1] / l.width) * 100,
    spineLeft: (l.panels.spine.x / l.width) * 100,
    spineWidth: (l.panels.spine.w / l.width) * 100,
  };
});

// 3D folded preview face backgrounds (cropped directly from the trimRect of the canvas)
const foldedStyle = computed(() => {
  const l = layout.value;
  const totalW = l.width;
  const totalH = l.height;
  // Scale so trimRect matches the 3D book faces cleanly
  const bgSizeW = (totalW / l.panels.front.w) * 100;
  const bgSizeH = (totalH / l.panels.front.h) * 100;
  const bgSizeSpineW = (totalW / l.panels.spine.w) * 100;

  const posPercent = (panelX: number, panelW: number) => {
    const denom = totalW - panelW;
    return denom > 0 ? (panelX / denom) * 100 : 0;
  };
  const posYPercent = () => {
    const denom = totalH - l.trimRect.h;
    return denom > 0 ? (l.trimRect.y / denom) * 100 : 0;
  };
  const yPct = posYPercent();
  const imgUrl = foldedDataUrl.value ? `url("${foldedDataUrl.value}")` : 'none';

  return {
    front: {
      backgroundImage: imgUrl,
      backgroundSize: `${bgSizeW}% ${bgSizeH}%`,
      backgroundPosition: `${posPercent(l.panels.right.x, l.panels.right.w)}% ${yPct}%`,
    },
    spine: {
      backgroundImage: imgUrl,
      backgroundSize: `${bgSizeSpineW}% ${bgSizeH}%`,
      backgroundPosition: `${posPercent(l.panels.spine.x, l.panels.spine.w)}% ${yPct}%`,
    },
    back: {
      backgroundImage: imgUrl,
      backgroundSize: `${bgSizeW}% ${bgSizeH}%`,
      backgroundPosition: `${posPercent(l.panels.left.x, l.panels.left.w)}% ${yPct}%`,
    },
  };
});

// Focus management
watch(
  open,
  async (isOpen) => {
    if (isOpen) {
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

function revokeAsset(asset: StagedSpineAsset | null) {
  if (asset?.url) URL.revokeObjectURL(asset.url);
}

function clearSessionAssets() {
  revokeAsset(uploadedSpine.value);
  revokeAsset(generatedSpine.value);
  uploadedSpine.value = null;
  generatedSpine.value = null;
  trimMode.value = false;
  saveConfirmOpen.value = false;
  saveStatusMessage.value = null;
  saveConflict.value = false;
  spineError.value = null;
  actionMessage.value = null;
  actionError.value = null;
  instructions.value = '';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

function sampleCoverPixels(img: HTMLImageElement): Uint8ClampedArray | null {
  try {
    const c = document.createElement('canvas');
    c.width = 36;
    c.height = 54;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  } catch {
    return null;
  }
}

function sampleImagePixelsForDetection(
  img: HTMLImageElement,
): { pixels: Uint8ClampedArray; width: number; height: number } | null {
  try {
    const maxDim = 240;
    const scale = Math.min(
      1,
      maxDim / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return { pixels: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
  } catch {
    return null;
  }
}

function applyRecommendedFit() {
  const report = spineRatio.value;
  if (!report) return;
  spineFit.value = report.recommendedFit;
  spineOffset.value = 0;
}

async function loadSavedSpine(bookId: string, token: number) {
  savedSpineError.value = null;
  savedSpineAsset.value = null;
  savedSpineRevision.value = null;
  try {
    const meta = await $fetch<{
      exists: boolean;
      revision: string | null;
    }>(`/api/books/${encodeURIComponent(bookId)}/spine?variant=metadata`);
    if (token !== loadToken) return;
    if (!meta.exists || !meta.revision) {
      spineSource.value = 'plain';
      return;
    }
    savedSpineRevision.value = meta.revision;
    const img = await loadImage(
      `/api/books/${encodeURIComponent(bookId)}/spine?v=${encodeURIComponent(meta.revision)}`,
    );
    if (token !== loadToken) return;
    savedSpineAsset.value = {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      edgeColor: sampleEdgeColor(img),
    };
    spineSource.value = 'saved';
    applyRecommendedFit();
  } catch {
    if (token !== loadToken) return;
    savedSpineError.value = 'Could not load the saved spine image.';
    spineSource.value = 'plain';
  }
}

async function loadEditorExtras(bookId: string, token: number) {
  connectionChecked.value = false;
  referencesLoading.value = true;
  referencesError.value = false;
  try {
    const status = await $fetch<{ connected: boolean }>(
      `/api/books/${encodeURIComponent(bookId)}/spine-generate/connection`,
    );
    if (token !== loadToken) return;
    connection.value = Boolean(status.connected);
  } catch {
    if (token !== loadToken) return;
    connection.value = false;
  } finally {
    if (token === loadToken) connectionChecked.value = true;
  }

  if (!connection.value) {
    referencesLoading.value = false;
    seriesSpines.value = [];
    selectedSeriesIds.value = [];
    return;
  }

  try {
    const refs = await $fetch<SeriesSpineReference[]>(
      `/api/books/${encodeURIComponent(bookId)}/spine-generate/series-references`,
    );
    if (token !== loadToken) return;
    seriesSpines.value = refs;
    selectedSeriesIds.value = refs
      .slice(0, seriesSelectionLimit.value)
      .map((item) => item.bookId);
  } catch {
    if (token !== loadToken) return;
    seriesSpines.value = [];
    selectedSeriesIds.value = [];
    referencesError.value = true;
  } finally {
    if (token === loadToken) referencesLoading.value = false;
  }
}

async function loadAll(bookId: string) {
  const token = ++loadToken;
  loading.value = true;
  loadError.value = null;
  book.value = null;
  coverAsset.value = null;
  coverFailed.value = false;
  savedSpineAsset.value = null;
  savedSpineRevision.value = null;
  savedSpineError.value = null;
  clearSessionAssets();
  previewMode.value = 'flat';
  actualSize.value = false;
  zoom.value = 100;
  foldedYaw.value = -20;

  try {
    const loaded = (await fetchBookDetail(bookId)) as BookSummary | null;
    if (token !== loadToken) return;
    if (!loaded) {
      loadError.value = 'Book not found.';
      return;
    }
    book.value = loaded;

    // Load cover and spine in parallel
    const coverPromise = (async () => {
      if (!loaded.coverImagePath) {
        palette.value = paletteFromHex(null);
        return;
      }
      try {
        const img = await loadImage(
          buildBookCoverUrl({
            bookId: loaded.id,
            variant: 'source',
            updatedAt: loaded.updatedAt,
          }),
        );
        if (token !== loadToken) return;
        coverAsset.value = {
          image: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
        const px = sampleCoverPixels(img);
        palette.value = px ? paletteFromPixels(px) : paletteFromHex(null);
      } catch {
        if (token !== loadToken) return;
        coverFailed.value = true;
        coverAsset.value = null;
        palette.value = paletteFromHex(null);
      }
    })();

    const spinePromise = loadSavedSpine(loaded.id, token);
    const extrasPromise = loaded.canEdit
      ? loadEditorExtras(loaded.id, token)
      : Promise.resolve();

    await Promise.all([coverPromise, spinePromise, extrasPromise]);
  } catch (err) {
    if (token !== loadToken) return;
    const e = err as { data?: { message?: string }; message?: string };
    loadError.value =
      e?.data?.message || e?.message || 'Could not load this book.';
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(
  () => store.openBookId,
  (id) => {
    if (id) {
      void loadAll(id);
    } else {
      loadToken++;
      generating.value = false;
      clearSessionAssets();
    }
  },
  { immediate: true },
);

// Render canvas whenever inputs change
function draw() {
  const el = canvasRef.value;
  const b = book.value;
  if (!el || !b || loading.value || loadError.value) return;

  const l = layout.value;
  if (el.width !== l.width) el.width = l.width;
  if (el.height !== l.height) el.height = l.height;
  const ctx = el.getContext('2d');
  if (!ctx) return;

  renderMiniCover(
    ctx,
    l,
    {
      cover: coverAsset.value,
      spine: spineSource.value === 'plain' ? null : activeSpineImage.value,
      spineCrop: activeSpineCrop.value,
      spineFit: spineFit.value,
      spineOffset: spineOffset.value,
      backStyle: backStyle.value,
      palette: palette.value,
      book: {
        id: b.id,
        title: b.title,
        authors: authorText.value,
      },
    },
    {
      foldMarks: foldMarks.value,
      trimMarks: effectiveTrimMarks.value,
    },
  );

  if (previewMode.value === 'folded') {
    try {
      foldedDataUrl.value = el.toDataURL('image/png');
    } catch {
      foldedDataUrl.value = null;
    }
  }
}

watch(
  [
    book,
    coverAsset,
    savedSpineAsset,
    uploadedSpine,
    generatedSpine,
    spineSource,
    spineFit,
    spineOffset,
    backStyle,
    orientation,
    resolution,
    bleedMm,
    foldMarks,
    trimMarks,
    palette,
    loading,
    loadError,
    previewMode,
    trimMode,
    canvasRef,
  ],
  async () => {
    await nextTick();
    draw();
  },
  { flush: 'post', deep: true },
);

function selectSpineSource(next: SpineSourceKind) {
  if (next === 'saved' && !savedSpineAsset.value) return;
  if (next === 'uploaded' && !uploadedSpine.value) return;
  if (next === 'generated' && !generatedSpine.value) return;
  trimMode.value = false;
  saveConfirmOpen.value = false;
  saveStatusMessage.value = null;
  spineSource.value = next;
  applyRecommendedFit();
}

// File staging (shared validation limits with SpineArtworkEditor)
async function stageSpineFile(
  chosen: File,
  target: 'uploaded' | 'generated',
  autoSuggestTrim: boolean,
): Promise<boolean> {
  if (!chosen.size || chosen.size > 10 * 1024 * 1024) {
    spineError.value = 'Choose an image under 10 MB.';
    return false;
  }
  const url = URL.createObjectURL(chosen);
  try {
    const img = await loadImage(url);
    if (img.naturalWidth * img.naturalHeight > 24_000_000) {
      throw new Error('Image too large');
    }
    const edgeColor = sampleEdgeColor(img);
    let initialCrop: CropInsets = { ...FULL_CROP_INSETS };
    if (autoSuggestTrim) {
      const sample = sampleImagePixelsForDetection(img);
      initialCrop = sample
        ? suggestOneToThreeCrop(sample.width, sample.height, sample.pixels)
        : suggestOneToThreeCrop(img.naturalWidth, img.naturalHeight);
    }
    const asset: StagedSpineAsset = {
      file: chosen,
      url,
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      edgeColor,
      crop: initialCrop,
    };

    if (target === 'uploaded') {
      revokeAsset(uploadedSpine.value);
      uploadedSpine.value = asset;
      spineSource.value = 'uploaded';
    } else {
      revokeAsset(generatedSpine.value);
      generatedSpine.value = asset;
      spineSource.value = 'generated';
    }
    spineError.value = null;
    saveConfirmOpen.value = false;
    saveStatusMessage.value = null;
    saveConflict.value = false;
    applyRecommendedFit();
    return true;
  } catch {
    URL.revokeObjectURL(url);
    spineError.value =
      'Could not read that image. Choose a JPEG, PNG, WebP, or AVIF under 24 megapixels.';
    return false;
  }
}

async function onChooseSpineFile(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  const chosen = event.target.files?.[0];
  event.target.value = '';
  if (!chosen) return;
  const ok = await stageSpineFile(chosen, 'uploaded', false);
  if (ok) {
    previewMode.value = 'flat';
    trimMode.value = false;
  }
}

// Fetch the active spine as a Blob to pass as `previous` to spine generation
async function getReferenceSpineFileForGeneration(): Promise<File | null> {
  if (spineSource.value === 'generated' && generatedSpine.value) {
    return generatedSpine.value.file;
  }
  if (spineSource.value === 'uploaded' && uploadedSpine.value) {
    return uploadedSpine.value.file;
  }
  if (book.value && savedSpineRevision.value) {
    try {
      const res = await fetch(
        `/api/books/${encodeURIComponent(book.value.id)}/spine?v=${encodeURIComponent(savedSpineRevision.value)}`,
      );
      if (res.ok) {
        const blob = await res.blob();
        return new File([blob], 'current-spine.webp', {
          type: blob.type || 'image/webp',
        });
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function generateOneToThreeSpine() {
  const b = book.value;
  if (
    !b ||
    generating.value ||
    !canEdit.value ||
    !connection.value ||
    !hasCover.value
  )
    return;

  const token = loadToken;
  generating.value = true;
  spineError.value = null;
  saveStatusMessage.value = null;
  saveConfirmOpen.value = false;

  try {
    const previousFile = await getReferenceSpineFileForGeneration();
    if (token !== loadToken) return;

    const userNote = instructions.value.trim();
    const combinedPrompt = previousFile
      ? userNote
        ? `${ONE_TO_THREE_PROMPT_PREFIX} ${userNote}`
        : ONE_TO_THREE_PROMPT_PREFIX
      : userNote
        ? `Make the spine exactly 1:3 width-to-height proportions (10×30 mm) with clean edges. ${userNote}`
        : 'Make the spine exactly 1:3 width-to-height proportions (10×30 mm) with clean edges and clear title and author lettering.';

    const body = new FormData();
    body.append('prompt', combinedPrompt.slice(0, 2000));
    body.append(
      'seriesReferences',
      JSON.stringify(
        seriesSpines.value
          .filter((item) => selectedSeriesIds.value.includes(item.bookId))
          .slice(0, seriesSelectionLimit.value)
          .map(({ bookId, revision }) => ({ bookId, revision })),
      ),
    );
    if (previousFile) {
      body.append('previous', previousFile);
    }

    const blob = await $fetch<Blob, 'blob'>(
      `/api/books/${encodeURIComponent(b.id)}/spine-generate`,
      { method: 'POST', body, responseType: 'blob' },
    );
    if (token !== loadToken) return;

    const ok = await stageSpineFile(
      new File([blob], 'generated-mini-spine', {
        type: blob.type || 'image/png',
      }),
      'generated',
      true,
    );
    if (ok && generatedSpine.value) {
      previewMode.value = 'flat';
      trimDraft.value = { ...generatedSpine.value.crop };
      trimLockRatio.value = true;
      trimMode.value = true;
    }
  } catch (cause: unknown) {
    if (token !== loadToken) return;
    let message =
      typeof cause === 'object' &&
      cause !== null &&
      'data' in cause &&
      typeof cause.data === 'object' &&
      cause.data !== null &&
      'statusMessage' in cause.data &&
      typeof cause.data.statusMessage === 'string'
        ? cause.data.statusMessage
        : 'Could not generate a 1:3 spine. Try again.';
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'data' in cause &&
      cause.data instanceof Blob
    ) {
      try {
        const parsed: unknown = JSON.parse(await cause.data.text());
        if (
          parsed &&
          typeof parsed === 'object' &&
          'statusMessage' in parsed &&
          typeof parsed.statusMessage === 'string'
        ) {
          message = parsed.statusMessage;
        }
      } catch {
        // Keep generic message
      }
    }
    spineError.value = message;
  } finally {
    if (token === loadToken) generating.value = false;
  }
}

// Trim editor interactions
function enterTrimMode() {
  const asset = activeStagedAsset.value;
  if (!asset) return;
  previewMode.value = 'flat';
  trimDraft.value = { ...asset.crop };
  trimMode.value = true;
}

function autoFitTrimToOneToThree() {
  const asset = activeStagedAsset.value;
  if (!asset) return;
  const sample = sampleImagePixelsForDetection(asset.image);
  trimDraft.value = sample
    ? suggestOneToThreeCrop(sample.width, sample.height, sample.pixels)
    : suggestOneToThreeCrop(asset.width, asset.height);
}

function applyTrimMode() {
  const asset = activeStagedAsset.value;
  if (!asset) {
    trimMode.value = false;
    return;
  }
  const updated: StagedSpineAsset = { ...asset, crop: { ...trimDraft.value } };
  if (spineSource.value === 'uploaded') {
    uploadedSpine.value = updated;
  } else if (spineSource.value === 'generated') {
    generatedSpine.value = updated;
  }
  trimMode.value = false;
  applyRecommendedFit();
}

function cancelTrimMode() {
  trimMode.value = false;
}

function clampCropPct(value: number, opposite: number) {
  return Math.max(
    0,
    Math.min(
      90,
      Math.floor((95 - opposite) * 10 + 0.000001) / 10,
      Math.round(value * 10) / 10,
    ),
  );
}

function adjustTrimCrop(
  initial: CropInsets,
  edges: CropEdge[],
  dx: number,
  dy: number,
) {
  const asset = activeStagedAsset.value;
  if (!asset) return;
  const next = { ...initial };
  if (edges.includes('left'))
    next.left = clampCropPct(initial.left + dx, initial.right);
  if (edges.includes('right'))
    next.right = clampCropPct(initial.right - dx, initial.left);
  if (edges.includes('top'))
    next.top = clampCropPct(initial.top + dy, initial.bottom);
  if (edges.includes('bottom'))
    next.bottom = clampCropPct(initial.bottom - dy, initial.top);

  if (trimLockRatio.value) {
    // Enforce 1:3 width-to-height on the crop box
    const horizChanged = edges.includes('left') || edges.includes('right');
    const vertChanged = edges.includes('top') || edges.includes('bottom');
    const visW = ((100 - next.left - next.right) / 100) * asset.width;
    const visH = ((100 - next.top - next.bottom) / 100) * asset.height;

    if (horizChanged && !vertChanged) {
      const targetH = visW / MINI_COVER_SPINE_RATIO;
      const targetHPct = (targetH / asset.height) * 100;
      if (targetHPct >= 5 && targetHPct <= 100) {
        const centerY = next.top + (100 - next.top - next.bottom) / 2;
        const top = Math.max(
          0,
          Math.min(100 - targetHPct, centerY - targetHPct / 2),
        );
        next.top = Math.round(top * 10) / 10;
        next.bottom = Math.round((100 - top - targetHPct) * 10) / 10;
      } else {
        return;
      }
    } else {
      const targetW = visH * MINI_COVER_SPINE_RATIO;
      const targetWPct = (targetW / asset.width) * 100;
      if (targetWPct >= 5 && targetWPct <= 100) {
        const centerX = next.left + (100 - next.left - next.right) / 2;
        const left = Math.max(
          0,
          Math.min(100 - targetWPct, centerX - targetWPct / 2),
        );
        next.left = Math.round(left * 10) / 10;
        next.right = Math.round((100 - left - targetWPct) * 10) / 10;
      } else {
        return;
      }
    }
  }
  trimDraft.value = next;
}

function startTrimDrag(event: PointerEvent, edges: CropEdge[]) {
  if (event.button !== 0 || !trimCanvasRef.value) return;
  const rect = trimCanvasRef.value.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  trimDrag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    width: rect.width,
    height: rect.height,
    initial: { ...trimDraft.value },
    edges,
  };
  trimCanvasRef.value.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveTrimDrag(event: PointerEvent) {
  if (!trimDrag || trimDrag.pointerId !== event.pointerId) return;
  adjustTrimCrop(
    trimDrag.initial,
    trimDrag.edges,
    ((event.clientX - trimDrag.x) * 100) / trimDrag.width,
    ((event.clientY - trimDrag.y) * 100) / trimDrag.height,
  );
}

function stopTrimDrag(event: PointerEvent) {
  if (trimDrag?.pointerId === event.pointerId) trimDrag = null;
}

function keyTrimCrop(event: KeyboardEvent, edges: CropEdge[]) {
  const step = event.shiftKey ? 1 : 0.2;
  const dx =
    event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
  const dy =
    event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
  if (!dx && !dy) return;
  event.preventDefault();
  adjustTrimCrop(trimDraft.value, edges, dx, dy);
}

// Drag inside the spine panel in Flat mode to pan the crop offset
function startSpinePan(event: PointerEvent) {
  if (!canDragSpineOffset.value || event.button !== 0) return;
  const el = event.currentTarget as HTMLElement | null;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const axis = spineRatio.value?.trimAxis === 'width' ? 'x' : 'y';
  spinePanDrag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startOffset: spineOffset.value,
    axis,
    spanPx: Math.max(40, axis === 'x' ? rect.width : rect.height),
  };
  el.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveSpinePan(event: PointerEvent) {
  if (!spinePanDrag || spinePanDrag.pointerId !== event.pointerId) return;
  const delta =
    spinePanDrag.axis === 'x'
      ? event.clientX - spinePanDrag.x
      : event.clientY - spinePanDrag.y;
  // Dragging right/down pulls the image in that direction (moves crop window opposite)
  const next = spinePanDrag.startOffset - (delta / spinePanDrag.spanPx) * 2;
  spineOffset.value = Math.max(-1, Math.min(1, Math.round(next * 100) / 100));
}

function stopSpinePan(event: PointerEvent) {
  if (spinePanDrag?.pointerId === event.pointerId) spinePanDrag = null;
}

// 3D folded view rotation
function startFoldRotate(event: PointerEvent) {
  if (event.button !== 0) return;
  const el = event.currentTarget as HTMLElement | null;
  if (!el) return;
  foldDrag = {
    pointerId: event.pointerId,
    x: event.clientX,
    startYaw: foldedYaw.value,
  };
  el.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveFoldRotate(event: PointerEvent) {
  if (!foldDrag || foldDrag.pointerId !== event.pointerId) return;
  const dx = event.clientX - foldDrag.x;
  foldedYaw.value = Math.max(-42, Math.min(42, foldDrag.startYaw + dx * 0.35));
}

function stopFoldRotate(event: PointerEvent) {
  if (foldDrag?.pointerId === event.pointerId) foldDrag = null;
}

// Save active local spine back to the book (editors only)
async function confirmSaveSpineToBook() {
  const b = book.value;
  const asset = activeStagedAsset.value;
  if (!b || !asset || !canEdit.value || savingToBook.value) return;

  savingToBook.value = true;
  spineError.value = null;
  saveStatusMessage.value = null;
  saveConflict.value = false;

  try {
    const edits = buildSpineEditsForSave({
      sourceWidth: asset.width,
      sourceHeight: asset.height,
      crop: asset.crop,
      fit: spineFit.value,
      offset: spineOffset.value,
    });
    const body = new FormData();
    body.append('file', asset.file);
    body.append('revision', savedSpineRevision.value ?? '');
    body.append('edits', JSON.stringify(edits));

    const result = await $fetch<{ revision: string }>(
      `/api/books/${encodeURIComponent(b.id)}/spine`,
      { method: 'POST', body },
    );

    savedSpineRevision.value = result.revision;
    invalidateBookDetail(b.id);
    store.notifySpineSaved(b.id, result.revision);
    saveConfirmOpen.value = false;
    saveStatusMessage.value = 'Saved as the book’s spine.';

    // Reload saved spine asset in the background so "Saved" reflects the new revision
    const img = await loadImage(
      `/api/books/${encodeURIComponent(b.id)}/spine?v=${encodeURIComponent(result.revision)}`,
    );
    savedSpineAsset.value = {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      edgeColor: sampleEdgeColor(img),
    };
  } catch (cause: unknown) {
    const isConflict =
      typeof cause === 'object' &&
      cause !== null &&
      'statusCode' in cause &&
      cause.statusCode === 409;
    if (isConflict) {
      saveConflict.value = true;
      spineError.value =
        'This book’s spine changed elsewhere. Reload the saved spine before saving, or keep downloading your local export.';
    } else {
      spineError.value =
        'Could not save the spine to the book. Your local preview is still ready to export.';
    }
  } finally {
    savingToBook.value = false;
  }
}

async function reloadSavedSpineAfterConflict() {
  if (!book.value) return;
  saveConflict.value = false;
  spineError.value = null;
  const token = loadToken;
  await loadSavedSpine(book.value.id, token);
}

// Export actions
async function onDownload() {
  const el = canvasRef.value;
  if (!el || exportBusy.value) return;
  exportBusy.value = 'download';
  actionMessage.value = null;
  actionError.value = null;
  try {
    draw();
    const blob = await canvasToPhysicalPngBlob(el, resInfo.value.pxPerMm);
    downloadPngBlob(blob, fileName.value);
    actionMessage.value = `Saved ${fileName.value}.`;
  } catch (err) {
    actionError.value =
      (err as Error)?.message || 'Could not download the PNG.';
  } finally {
    exportBusy.value = null;
  }
}

async function onCopyImage() {
  const el = canvasRef.value;
  if (!el || exportBusy.value || !copySupported) return;
  exportBusy.value = 'copy';
  actionMessage.value = null;
  actionError.value = null;
  try {
    draw();
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': canvasToPhysicalPngBlob(el, resInfo.value.pxPerMm),
      }),
    ]);
    actionMessage.value = 'Copied the mini cover image.';
  } catch (err) {
    actionError.value = (err as Error)?.message || 'Could not copy the image.';
  } finally {
    exportBusy.value = null;
  }
}

function jumpToGenerate() {
  generateSectionRef.value?.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
  });
}

function jumpToUpload() {
  uploadButtonRef.value?.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
  });
  uploadButtonRef.value?.focus();
}

function close() {
  store.close();
}

onBeforeUnmount(() => {
  loadToken++;
  clearSessionAssets();
});
</script>

<template>
  <ModalWindow :open="open" :width-full="true" @close="close">
    <section
      ref="dialog"
      class="mini-cover-studio"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mini-cover-dialog-title"
      @keydown="trapFocus"
    >
      <header class="studio-header">
        <div>
          <h2 id="mini-cover-dialog-title">Mini book cover</h2>
          <p>{{ subtitleText }}</p>
        </div>
        <button
          ref="closeButton"
          type="button"
          aria-label="Close mini book cover studio"
          @click="close"
        >
          <Icon name="lucide:x" aria-hidden="true" />
        </button>
      </header>

      <div v-if="loading" class="studio-loading" role="status">
        <Icon
          name="lucide:loader-circle"
          class="text-2xl motion-safe:animate-spin"
          aria-hidden="true"
        />
        <span>Preparing mini book cover…</span>
      </div>

      <p v-else-if="loadError" role="alert" class="studio-error">
        {{ loadError }}
      </p>

      <div v-else-if="book" class="studio-layout">
        <!-- Left: Live preview stage -->
        <div class="preview-column">
          <div class="preview-stage">
            <div v-if="generating" class="generation-overlay" role="status">
              <Icon
                name="lucide:loader-circle"
                class="text-3xl motion-safe:animate-spin"
                aria-hidden="true"
              />
              <span>Generating a 1:3 spine…</span>
            </div>

            <!-- Inline 1:3 trim mode for generated or uploaded spines -->
            <template v-if="trimMode && activeStagedAsset">
              <div class="trim-viewport">
                <div
                  ref="trimCanvasRef"
                  class="crop-canvas"
                  :style="{
                    aspectRatio: `${activeStagedAsset.width} / ${activeStagedAsset.height}`,
                    width: `${Math.min(260, 420 * (activeStagedAsset.width / activeStagedAsset.height))}px`,
                  }"
                  @pointermove="moveTrimDrag"
                  @pointerup="stopTrimDrag"
                  @pointercancel="stopTrimDrag"
                >
                  <img
                    :src="activeStagedAsset.url"
                    alt="Spine image with 1:3 trim handles"
                  />
                  <div class="crop-mask" aria-hidden="true">
                    <div
                      class="crop-mask-selection"
                      :style="{
                        left: `${trimDraft.left}%`,
                        right: `${trimDraft.right}%`,
                        top: `${trimDraft.top}%`,
                        bottom: `${trimDraft.bottom}%`,
                      }"
                    />
                  </div>
                  <div
                    class="crop-selection"
                    :style="{
                      left: `${trimDraft.left}%`,
                      right: `${trimDraft.right}%`,
                      top: `${trimDraft.top}%`,
                      bottom: `${trimDraft.bottom}%`,
                    }"
                  >
                    <button
                      v-for="handle in cropHandles"
                      :key="handle.name"
                      type="button"
                      class="crop-handle"
                      :class="`handle-${handle.name}`"
                      :aria-label="`Drag ${handle.name} trim handle`"
                      @pointerdown.stop="startTrimDrag($event, handle.edges)"
                      @keydown="keyTrimCrop($event, handle.edges)"
                    />
                  </div>
                </div>
              </div>
              <div class="trim-bar">
                <label class="trim-lock">
                  <input v-model="trimLockRatio" type="checkbox" />
                  <span>Lock 1:3 ratio</span>
                </label>
                <div class="trim-bar-actions">
                  <button type="button" @click="autoFitTrimToOneToThree">
                    Auto-fit 1:3
                  </button>
                  <button type="button" @click="cancelTrimMode">Cancel</button>
                  <button
                    type="button"
                    class="trim-apply"
                    @click="applyTrimMode"
                  >
                    Apply trim
                  </button>
                </div>
              </div>
            </template>

            <!-- 3D Folded preview mode -->
            <template v-else-if="previewMode === 'folded'">
              <div
                class="folded-stage"
                tabindex="0"
                aria-label="3D folded mini book preview. Drag horizontally to rotate."
                @pointerdown="startFoldRotate"
                @pointermove="moveFoldRotate"
                @pointerup="stopFoldRotate"
                @pointercancel="stopFoldRotate"
              >
                <div
                  class="mini-book-3d"
                  :style="{
                    transform: `rotateX(-10deg) rotateY(${foldedYaw}deg)`,
                  }"
                >
                  <div
                    class="book-face book-face-spine"
                    :style="foldedStyle.spine"
                  />
                  <div
                    class="book-face book-face-front"
                    :style="foldedStyle.front"
                  />
                  <div
                    class="book-face book-face-back"
                    :style="foldedStyle.back"
                  />
                  <div class="book-face book-face-pages" />
                  <div class="book-face book-face-top-pages" />
                </div>
              </div>
              <span class="preview-label">
                Drag horizontally to rotate · 20 × 10 × 30 mm
              </span>
            </template>

            <!-- Flat wrap live canvas preview (default) -->
            <template v-else>
              <div class="flat-viewport">
                <div class="flat-wrap-shell">
                  <div
                    class="canvas-frame"
                    :style="{
                      width: flatPreviewWidthStyle,
                      aspectRatio: `${layout.width} / ${layout.height}`,
                    }"
                  >
                    <canvas
                      ref="canvasRef"
                      :width="layout.width"
                      :height="layout.height"
                      class="mini-cover-canvas"
                      role="img"
                      :aria-label="`Mini book cover preview for ${book.title}`"
                    />

                    <!-- Direct drag target over the spine when crop offset is active -->
                    <div
                      v-if="canDragSpineOffset"
                      class="spine-pan-target"
                      :style="{
                        left: `${guidePercents.spineLeft}%`,
                        width: `${guidePercents.spineWidth}%`,
                        top: `${guidePercents.trimTop}%`,
                        height: `${guidePercents.trimHeight}%`,
                      }"
                      title="Drag to reposition the spine crop"
                      @pointerdown="startSpinePan"
                      @pointermove="moveSpinePan"
                      @pointerup="stopSpinePan"
                      @pointercancel="stopSpinePan"
                    />

                    <!-- Non-exported visual fold & ratio guides -->
                    <svg
                      v-if="showGuides"
                      class="guide-overlay"
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      <rect
                        v-if="bleedMm > 0"
                        :x="guidePercents.trimLeft"
                        :y="guidePercents.trimTop"
                        :width="guidePercents.trimWidth"
                        :height="guidePercents.trimHeight"
                        class="guide-trim"
                      />
                      <line
                        :x1="guidePercents.fold1"
                        :y1="guidePercents.trimTop"
                        :x2="guidePercents.fold1"
                        :y2="guidePercents.trimTop + guidePercents.trimHeight"
                        class="guide-fold"
                      />
                      <line
                        :x1="guidePercents.fold2"
                        :y1="guidePercents.trimTop"
                        :x2="guidePercents.fold2"
                        :y2="guidePercents.trimTop + guidePercents.trimHeight"
                        class="guide-fold"
                      />
                      <rect
                        v-if="
                          spineSource !== 'plain' &&
                          spineRatio &&
                          spineRatio.state !== 'fit'
                        "
                        :x="guidePercents.spineLeft"
                        :y="guidePercents.trimTop"
                        :width="guidePercents.spineWidth"
                        :height="guidePercents.trimHeight"
                        :class="
                          spineRatio.state === 'mismatch'
                            ? 'guide-spine-error'
                            : 'guide-spine-warn'
                        "
                      />
                    </svg>
                  </div>

                  <!-- Height bracket on the right -->
                  <div
                    v-if="showGuides"
                    class="height-bracket"
                    aria-hidden="true"
                  >
                    <span>30 mm</span>
                  </div>
                </div>

                <!-- Bottom dimension chips aligned to the 3 panels -->
                <div
                  v-if="showGuides"
                  class="panel-chips"
                  :style="{ width: flatPreviewWidthStyle }"
                  aria-hidden="true"
                >
                  <span class="chip-cover">
                    {{
                      orientation === 'ltr'
                        ? backStyle === 'same'
                          ? 'Cover · 20 mm'
                          : 'Back · 20 mm'
                        : 'Front · 20 mm'
                    }}
                  </span>
                  <span class="chip-spine">Spine · 10 mm</span>
                  <span class="chip-cover">
                    {{
                      orientation === 'ltr'
                        ? 'Cover · 20 mm'
                        : backStyle === 'same'
                          ? 'Cover · 20 mm'
                          : 'Back · 20 mm'
                    }}
                  </span>
                </div>
              </div>

              <span class="preview-label">
                {{
                  canDragSpineOffset
                    ? 'Drag spine to reposition · Fold guides are preview-only'
                    : actualSize
                      ? 'Approximate 50 × 30 mm actual size on screen'
                      : '50 × 30 mm flat wrap · Preview matches exported PNG'
                }}
              </span>
            </template>
          </div>

          <!-- Preview toolbar -->
          <div class="preview-tools">
            <div class="tool-group" role="group" aria-label="Preview mode">
              <button
                type="button"
                :class="{ active: previewMode === 'flat' && !trimMode }"
                :aria-pressed="previewMode === 'flat' && !trimMode"
                @click="
                  trimMode = false;
                  previewMode = 'flat';
                "
              >
                Flat
              </button>
              <button
                type="button"
                :class="{ active: previewMode === 'folded' && !trimMode }"
                :aria-pressed="previewMode === 'folded' && !trimMode"
                @click="
                  trimMode = false;
                  previewMode = 'folded';
                "
              >
                3D Folded
              </button>
            </div>

            <div class="tool-group">
              <button
                v-if="previewMode === 'flat' && !trimMode"
                type="button"
                :class="{ active: showGuides }"
                :aria-pressed="showGuides"
                @click="showGuides = !showGuides"
              >
                Guides
              </button>
              <button
                v-if="previewMode === 'flat' && !trimMode"
                type="button"
                :class="{ active: actualSize }"
                :aria-pressed="actualSize"
                title="Approximate 50 × 30 mm physical scale (depends on display DPI)"
                @click="actualSize = !actualSize"
              >
                Actual size
              </button>
            </div>

            <div
              v-if="previewMode === 'flat' && !trimMode"
              class="zoom-controls"
              aria-label="Preview zoom"
            >
              <button
                type="button"
                aria-label="Zoom out"
                :disabled="actualSize || zoom <= 60"
                @click="zoom = Math.max(60, zoom - 20)"
              >
                <Icon name="lucide:minus" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Reset zoom"
                @click="
                  actualSize = false;
                  zoom = 100;
                "
              >
                {{ actualSize ? '~1:1' : `${zoom}%` }}
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                :disabled="actualSize || zoom >= 200"
                @click="zoom = Math.min(200, zoom + 20)"
              >
                <Icon name="lucide:plus" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <!-- Right: Controls column -->
        <div class="control-column">
          <!-- Section A: Spine -->
          <section class="control-section">
            <div class="controls-heading">
              <div>
                <h3>Spine (10 × 30 mm · 1:3)</h3>
                <p>
                  Use the saved spine, upload your own, or regenerate at 1:3.
                </p>
              </div>
              <Icon name="lucide:columns-3" aria-hidden="true" />
            </div>

            <!-- Ratio status indicator -->
            <div
              v-if="spineSource === 'plain'"
              class="ratio-pill ratio-neutral"
            >
              <Icon
                name="lucide:info"
                class="w-4 h-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                {{
                  savedSpineAsset
                    ? 'Using a plain 1:3 spine.'
                    : 'No spine artwork yet. Using a plain 1:3 spine.'
                }}
              </span>
            </div>

            <div
              v-else-if="spineRatio?.state === 'fit'"
              class="ratio-pill ratio-good"
            >
              <Icon
                name="lucide:check"
                class="w-4 h-4 shrink-0"
                aria-hidden="true"
              />
              <span>Fits the 10 × 30 mm spine ({{ spineRatio.label }}).</span>
            </div>

            <div
              v-else-if="spineRatio?.state === 'slight'"
              class="ratio-pill ratio-warn"
            >
              <Icon
                name="lucide:triangle-alert"
                class="w-4 h-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                Slightly off 1:3 (currently {{ spineRatio.label }}). Cropping
                trims about
                {{ Math.max(0.5, spineRatio.trimMm).toFixed(1) }} mm.
              </span>
            </div>

            <div
              v-else-if="spineRatio?.state === 'mismatch'"
              class="studio-error"
              role="status"
            >
              <p>
                This spine is {{ spineRatio.label }}, not 1:3.
                {{
                  spineRatio.recommendedFit === 'fit'
                    ? 'It is much wider than 1:3, so regenerating or uploading a narrow spine works best.'
                    : 'Choose how to fit it below, or make a 1:3 spine.'
                }}
              </p>
              <div class="error-links">
                <button
                  v-if="canEdit && connection && hasCover"
                  type="button"
                  @click="jumpToGenerate"
                >
                  Regenerate as 1:3
                </button>
                <button type="button" @click="jumpToUpload">
                  Upload a spine
                </button>
              </div>
            </div>

            <p v-if="savedSpineError" role="alert" class="studio-error">
              {{ savedSpineError }}
              <button
                type="button"
                @click="book && loadSavedSpine(book.id, loadToken)"
              >
                Retry
              </button>
            </p>

            <p v-if="spineError" role="alert" class="studio-error">
              {{ spineError }}
              <button
                v-if="saveConflict"
                type="button"
                @click="reloadSavedSpineAfterConflict"
              >
                Reload saved spine
              </button>
            </p>

            <!-- Source switcher -->
            <fieldset class="field-group">
              <legend>Spine source</legend>
              <div class="segmented-row">
                <button
                  type="button"
                  :disabled="!savedSpineAsset"
                  :class="{ active: spineSource === 'saved' }"
                  :aria-pressed="spineSource === 'saved'"
                  :title="
                    savedSpineAsset
                      ? 'Use the book’s saved spine'
                      : 'No saved spine yet'
                  "
                  @click="selectSpineSource('saved')"
                >
                  Saved
                </button>
                <button
                  v-if="uploadedSpine"
                  type="button"
                  :class="{ active: spineSource === 'uploaded' }"
                  :aria-pressed="spineSource === 'uploaded'"
                  @click="selectSpineSource('uploaded')"
                >
                  Uploaded
                </button>
                <button
                  v-if="generatedSpine"
                  type="button"
                  :class="{ active: spineSource === 'generated' }"
                  :aria-pressed="spineSource === 'generated'"
                  @click="selectSpineSource('generated')"
                >
                  Generated
                </button>
                <button
                  type="button"
                  :class="{ active: spineSource === 'plain' }"
                  :aria-pressed="spineSource === 'plain'"
                  @click="selectSpineSource('plain')"
                >
                  Plain
                </button>
              </div>
            </fieldset>

            <!-- Fit mode when aspect ratio differs from 1:3 -->
            <fieldset v-if="showFitControls" class="field-group">
              <legend>Fit to 1:3</legend>
              <div class="segmented-row">
                <button
                  v-for="opt in [
                    { value: 'crop' as const, label: 'Crop' },
                    { value: 'fit' as const, label: 'Fit' },
                    { value: 'stretch' as const, label: 'Stretch' },
                  ]"
                  :key="opt.value"
                  type="button"
                  :class="{ active: spineFit === opt.value }"
                  :aria-pressed="spineFit === opt.value"
                  @click="spineFit = opt.value"
                >
                  {{ opt.label }}
                </button>
              </div>
              <p v-if="spineFit === 'crop'" class="field-hint">
                Drag the spine in the preview to reposition.
                <button
                  v-if="spineOffset !== 0"
                  type="button"
                  class="inline-link"
                  @click="spineOffset = 0"
                >
                  Center
                </button>
              </p>
            </fieldset>

            <!-- Upload + Trim + Save-to-book actions -->
            <input
              ref="filePicker"
              type="file"
              class="hidden"
              accept="image/jpeg,image/png,image/webp,image/avif"
              :disabled="generating"
              @change="onChooseSpineFile"
            />
            <div class="actions">
              <button
                ref="uploadButtonRef"
                type="button"
                class="upload-action"
                :disabled="generating"
                @click="filePicker?.click()"
              >
                <Icon name="lucide:image-up" aria-hidden="true" />
                Upload spine image
              </button>
              <button
                v-if="activeStagedAsset"
                type="button"
                :disabled="generating"
                @click="trimMode ? cancelTrimMode() : enterTrimMode()"
              >
                <Icon name="lucide:crop" aria-hidden="true" />
                {{ trimMode ? 'Exit trim' : 'Trim spine' }}
              </button>
              <button
                v-if="canEdit && hasUnsavedLocalSpine"
                type="button"
                :disabled="generating || savingToBook"
                @click="saveConfirmOpen = !saveConfirmOpen"
              >
                <Icon name="lucide:save" aria-hidden="true" />
                Save spine to book
              </button>
            </div>
            <p v-if="hasUnsavedLocalSpine" class="field-hint">
              Used for this export only unless saved to the book.
            </p>
            <p v-if="saveStatusMessage" role="status" class="status-message">
              {{ saveStatusMessage }}
            </p>

            <!-- Inline confirmation for saving local spine back to the book -->
            <div
              v-if="saveConfirmOpen && canEdit && hasUnsavedLocalSpine"
              class="confirm-box"
            >
              <p>
                Replace this book’s spine for everyone? This replaces the
                current spine artwork.
              </p>
              <div class="actions">
                <button
                  type="button"
                  class="upload-action"
                  :disabled="savingToBook"
                  @click="confirmSaveSpineToBook"
                >
                  {{ savingToBook ? 'Saving…' : 'Replace book spine' }}
                </button>
                <button
                  type="button"
                  :disabled="savingToBook"
                  @click="saveConfirmOpen = false"
                >
                  Cancel
                </button>
              </div>
            </div>

            <!-- Regenerate as 1:3 block -->
            <div ref="generateSectionRef" class="generation">
              <div class="controls-heading">
                <div>
                  <h3>Make a 1:3 spine</h3>
                  <p>
                    Experimental · Regenerates a 1:3 spine using the saved cover
                    and ChatGPT.
                  </p>
                </div>
                <Icon name="lucide:sparkles" aria-hidden="true" />
              </div>

              <p v-if="!canEdit" class="generation-note">
                Only people who can edit this book can generate or save spines.
                You can still upload any spine image above for this export.
              </p>
              <p
                v-else-if="connectionChecked && !connection"
                class="generation-note"
              >
                Spine generation is not configured. Ask an administrator to
                connect ChatGPT in Admin settings.
              </p>
              <template v-else-if="connection">
                <div v-if="referencesLoading" class="generation-note">
                  Looking for other spines in this series…
                </div>
                <fieldset
                  v-else-if="seriesSpines.length"
                  class="series-references"
                >
                  <legend>Match other spines in this series</legend>
                  <div class="series-reference-list">
                    <label
                      v-for="item in seriesSpines"
                      :key="item.bookId"
                      class="series-reference"
                      :title="item.title"
                    >
                      <img
                        :src="`/api/books/${encodeURIComponent(item.bookId)}/spine?v=${encodeURIComponent(item.revision)}`"
                        alt=""
                        loading="lazy"
                      />
                      <input
                        v-model="selectedSeriesIds"
                        type="checkbox"
                        :value="item.bookId"
                        :aria-label="`Use ${item.title} as a series reference`"
                        :disabled="
                          generating ||
                          (!selectedSeriesIds.includes(item.bookId) &&
                            selectedSeriesIds.length >= seriesSelectionLimit)
                        "
                      />
                    </label>
                  </div>
                </fieldset>

                <label class="generation-label">
                  {{
                    generatedSpine
                      ? 'How should the 1:3 preview change?'
                      : 'Extra instructions (optional)'
                  }}
                  <textarea
                    v-model="instructions"
                    maxlength="1800"
                    rows="2"
                    :disabled="generating"
                    placeholder="For example, keep the gold lettering larger and centered"
                  />
                </label>

                <div class="actions">
                  <button
                    type="button"
                    :disabled="generating || !hasCover"
                    @click="generateOneToThreeSpine"
                  >
                    <Icon
                      :name="
                        generating ? 'lucide:loader-circle' : 'lucide:sparkles'
                      "
                      :class="{ 'motion-safe:animate-spin': generating }"
                      aria-hidden="true"
                    />
                    {{
                      generating
                        ? 'Generating…'
                        : generatedSpine
                          ? 'Update 1:3 preview'
                          : hasReferenceSpineForGeneration
                            ? 'Regenerate from current spine'
                            : 'Generate 1:3 spine'
                    }}
                  </button>
                </div>
                <p v-if="!hasCover" class="generation-note">
                  Add a cover before generating a spine.
                </p>
                <p v-else class="generation-note">
                  {{
                    hasReferenceSpineForGeneration
                      ? 'Sends the current spine and cover to ChatGPT, then opens a 1:3 trim box.'
                      : 'Sends the cover to ChatGPT, then opens a 1:3 trim box.'
                  }}
                </p>
              </template>
            </div>
          </section>

          <!-- Section B: Covers -->
          <section class="control-section section-divider">
            <div class="controls-heading">
              <div>
                <h3>Covers (20 × 30 mm · 2:3)</h3>
                <p>Configure the left and right cover panels.</p>
              </div>
              <Icon name="lucide:book-open" aria-hidden="true" />
            </div>

            <p v-if="!coverAsset" class="generation-note">
              {{
                coverFailed
                  ? 'Could not load the book cover. Using a plain cover.'
                  : 'No cover image on this book. Using a plain cover.'
              }}
            </p>
            <p v-else-if="coverRatioNote" class="generation-note">
              {{ coverRatioNote }}
            </p>

            <fieldset class="field-group">
              <legend>Back panel</legend>
              <div class="segmented-row">
                <button
                  v-for="opt in [
                    { value: 'same' as const, label: 'Same cover' },
                    { value: 'solid' as const, label: 'Cover color' },
                    { value: 'blur' as const, label: 'Blurred' },
                  ]"
                  :key="opt.value"
                  type="button"
                  :disabled="opt.value === 'blur' && !coverAsset"
                  :class="{ active: backStyle === opt.value }"
                  :aria-pressed="backStyle === opt.value"
                  @click="backStyle = opt.value"
                >
                  {{ opt.label }}
                </button>
              </div>
            </fieldset>

            <fieldset class="field-group">
              <legend>Orientation</legend>
              <div class="segmented-row">
                <button
                  type="button"
                  :class="{ active: orientation === 'ltr' }"
                  :aria-pressed="orientation === 'ltr'"
                  @click="orientation = 'ltr'"
                >
                  Front on right
                </button>
                <button
                  type="button"
                  :class="{ active: orientation === 'rtl' }"
                  :aria-pressed="orientation === 'rtl'"
                  @click="orientation = 'rtl'"
                >
                  Front on left
                </button>
              </div>
            </fieldset>
          </section>

          <!-- Section C: Export -->
          <section class="control-section section-divider">
            <div class="controls-heading">
              <div>
                <h3>Export PNG</h3>
                <p>
                  Output: {{ layout.width }} × {{ layout.height }} px · exact 50
                  × 30 mm print DPI embedded
                </p>
              </div>
              <Icon name="lucide:printer" aria-hidden="true" />
            </div>

            <fieldset class="field-group">
              <legend>Resolution</legend>
              <div class="segmented-row">
                <button
                  v-for="opt in MINI_COVER_RESOLUTIONS"
                  :key="opt.value"
                  type="button"
                  :class="{ active: resolution === opt.value }"
                  :aria-pressed="resolution === opt.value"
                  :title="`${50 * opt.pxPerMm} × ${30 * opt.pxPerMm} px (before bleed)`"
                  @click="resolution = opt.value"
                >
                  {{ opt.label }}
                </button>
              </div>
            </fieldset>

            <fieldset class="field-group">
              <legend>Bleed</legend>
              <div class="segmented-row">
                <button
                  v-for="mm in MINI_COVER_BLEEDS"
                  :key="mm"
                  type="button"
                  :class="{ active: bleedMm === mm }"
                  :aria-pressed="bleedMm === mm"
                  @click="bleedMm = mm"
                >
                  {{ mm === 0 ? 'None' : `${mm} mm` }}
                </button>
              </div>
            </fieldset>

            <div class="check-row">
              <label>
                <input v-model="foldMarks" type="checkbox" />
                <span>Fold ticks (at 20 mm &amp; 30 mm)</span>
              </label>
              <label v-if="bleedMm > 0">
                <input v-model="trimMarks" type="checkbox" />
                <span>Corner trim marks (+3 mm margin)</span>
              </label>
            </div>

            <p v-if="lowResWarning" class="generation-note">
              {{ lowResWarning }}
            </p>

            <div class="export-actions">
              <button
                type="button"
                class="export-primary"
                :disabled="exportBusy !== null || generating || trimMode"
                @click="onDownload"
              >
                <Icon
                  name="lucide:download"
                  class="w-4 h-4"
                  aria-hidden="true"
                />
                {{ exportBusy === 'download' ? 'Preparing…' : 'Download PNG' }}
              </button>
              <button
                v-if="copySupported"
                type="button"
                class="export-secondary"
                :disabled="exportBusy !== null || generating || trimMode"
                @click="onCopyImage"
              >
                <Icon name="lucide:copy" class="w-4 h-4" aria-hidden="true" />
                {{ exportBusy === 'copy' ? 'Copying…' : 'Copy image' }}
              </button>
            </div>

            <p v-if="actionMessage" role="status" class="status-message">
              {{ actionMessage }}
            </p>
            <p v-if="actionError" role="alert" class="studio-error">
              {{ actionError }}
            </p>
            <p class="generation-note">
              Print at 100% / Actual size (turn off “Fit to page”). The image
              has no link to your library.
            </p>
          </section>
        </div>
      </div>

      <footer class="studio-footer">
        <span v-if="canEdit && hasUnsavedLocalSpine" class="footer-note">
          Your {{ spineSource }} spine is used for this export only.
        </span>
        <span v-else class="footer-note">
          20 × 10 × 30 mm miniature wrap (50 × 30 mm flat)
        </span>
        <button type="button" @click="close">Done</button>
      </footer>
    </section>
  </ModalWindow>
</template>

<style scoped>
.mini-cover-studio {
  width: 100%;
  height: min(760px, calc(100dvh - 4rem));
  max-height: calc(100dvh - 4rem);
  display: flex;
  flex-direction: column;
  color: var(--contrast-text-color);
}
.studio-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--contrast-border-color);
}
.studio-header h2 {
  font-size: 20px;
}
.studio-header p {
  margin-top: 3px;
  font-size: 12px;
  opacity: 0.75;
}
.studio-header button {
  padding: 4px;
  font-size: 20px;
}
.studio-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 13px;
  opacity: 0.8;
}
.studio-layout {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 20px;
  min-height: 0;
  overflow: hidden;
}
.preview-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.control-column {
  padding: 12px 4px 16px;
  overflow: auto;
}
.studio-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--contrast-border-color);
}
.footer-note {
  font-size: 12px;
  opacity: 0.72;
}
.studio-footer button {
  padding: 8px 16px;
  border-radius: 7px;
  background: var(--main-color);
  color: var(--contrast-inverse-color);
  font-size: 13px;
  font-weight: 600;
}
@media (max-width: 720px) {
  .mini-cover-studio {
    height: auto;
  }
  .studio-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto;
    gap: 8px;
    overflow: auto;
  }
  .preview-column {
    height: min(400px, max(260px, calc(100dvh - 16rem)));
  }
  .control-column {
    overflow: visible;
  }
}

.preview-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 0;
  gap: 10px;
  margin-top: 14px;
  padding: 18px 14px 12px;
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
.generation-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
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

.flat-viewport {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  gap: 8px;
}
.flat-wrap-shell {
  display: flex;
  align-items: stretch;
  gap: 8px;
  margin: auto 0;
}
.canvas-frame {
  position: relative;
  max-width: 100%;
  flex: none;
  border-radius: 3px;
  box-shadow: 0 7px 18px #0003;
  background: var(--sub-alt-color);
  overflow: hidden;
}
.mini-cover-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.spine-pan-target {
  position: absolute;
  z-index: 2;
  cursor: grab;
  touch-action: none;
}
.spine-pan-target:active {
  cursor: grabbing;
}
.guide-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}
.guide-fold {
  stroke: white;
  stroke-width: 0.45;
  stroke-dasharray: 2 1.8;
  mix-blend-mode: difference;
}
.guide-trim {
  fill: none;
  stroke: white;
  stroke-width: 0.4;
  stroke-dasharray: 1.5 1.5;
  mix-blend-mode: difference;
}
.guide-spine-warn {
  fill: none;
  stroke: var(--main-color);
  stroke-width: 0.7;
  stroke-dasharray: 2 1.5;
  opacity: 0.75;
}
.guide-spine-error {
  fill: none;
  stroke: var(--error-color);
  stroke-width: 0.8;
  stroke-dasharray: 2 1.5;
  opacity: 0.85;
}
.height-bracket {
  display: flex;
  align-items: center;
  border-left: 1px solid
    color-mix(in srgb, var(--contrast-border-color) 65%, transparent);
  padding-left: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.7;
  white-space: nowrap;
}
.panel-chips {
  display: grid;
  grid-template-columns: 2fr 1fr 2fr;
  max-width: 100%;
  gap: 2px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.72;
}
.chip-spine {
  color: var(--contrast-main-color);
}
.preview-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.7;
  text-align: center;
}

/* 3D Folded preview */
.folded-stage {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  perspective: 900px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.folded-stage:active {
  cursor: grabbing;
}
.mini-book-3d {
  position: relative;
  width: 68px;
  height: 204px;
  transform-style: preserve-3d;
  transition: transform 80ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .mini-book-3d {
    transition: none;
  }
}
.book-face {
  position: absolute;
  inset: 0;
  backface-visibility: hidden;
  background-repeat: no-repeat;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
}
.book-face-spine {
  width: 68px;
  height: 204px;
  transform: translateZ(68px);
}
.book-face-front {
  width: 136px;
  height: 204px;
  left: 68px;
  transform-origin: left center;
  transform: translateZ(68px) rotateY(84deg);
}
.book-face-back {
  width: 136px;
  height: 204px;
  left: -136px;
  transform-origin: right center;
  transform: translateZ(68px) rotateY(-84deg);
}
.book-face-pages {
  width: 64px;
  height: 198px;
  top: 3px;
  left: 2px;
  transform: translateZ(-64px) rotateY(180deg);
  background: linear-gradient(90deg, #ede9df, #f7f4ec 50%, #e4dfd3);
}
.book-face-top-pages {
  width: 64px;
  height: 132px;
  left: 2px;
  top: -66px;
  transform-origin: center center;
  transform: translateZ(2px) rotateX(90deg);
  background: repeating-linear-gradient(
    90deg,
    #f6f2e9 0px,
    #f6f2e9 2px,
    #e5dfd1 3px
  );
}

/* Inline trim editor (mirrors SpineArtworkEditor handles) */
.trim-viewport {
  display: flex;
  flex: 1;
  width: 100%;
  min-height: 0;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow: auto;
}
.crop-canvas {
  position: relative;
  flex: none;
  border-radius: 3px;
  background: var(--sub-alt-color);
  box-shadow: 0 7px 18px #0003;
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

.trim-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding-top: 6px;
}
.trim-lock {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.trim-bar-actions {
  display: flex;
  gap: 6px;
}
.trim-bar-actions button {
  padding: 5px 10px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 7px;
  background: var(--bg-color);
  font-size: 12px;
  font-weight: 600;
}
.trim-bar-actions .trim-apply {
  background: var(--main-color);
  border-color: var(--main-color);
  color: var(--contrast-inverse-color);
}

/* Preview toolbar */
.preview-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 10px 0 12px;
}
.tool-group,
.zoom-controls {
  display: flex;
  align-items: center;
  gap: 5px;
}
.preview-tools button {
  min-height: 32px;
  padding: 5px 9px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 7px;
  background: var(--bg-color);
  font-size: 12px;
}
.preview-tools button.active {
  border-color: var(--contrast-main-color);
  color: var(--contrast-main-color);
}
.preview-tools button:disabled {
  opacity: 0.45;
}
.zoom-controls button {
  min-width: 32px;
}

/* Control column */
.section-divider {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid
    color-mix(in srgb, var(--contrast-border-color) 40%, transparent);
}
.controls-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
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
.ratio-pill {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
}
.ratio-good {
  color: var(--contrast-main-color);
  background: color-mix(in srgb, var(--main-color) 10%, var(--bg-color));
}
.ratio-warn,
.ratio-neutral {
  background: color-mix(in srgb, var(--sub-alt-color) 85%, var(--bg-color));
  opacity: 0.88;
}
.studio-error {
  margin-top: 10px;
  padding: 9px 10px;
  border-radius: 8px;
  color: var(--contrast-error-color);
  background: color-mix(in srgb, var(--error-color) 10%, var(--bg-color));
  font-size: 12px;
  line-height: 1.45;
}
.studio-error button {
  text-decoration: underline;
  font-weight: 600;
}
.error-links {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
}

.field-group {
  margin-top: 12px;
}
.field-group legend {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.segmented-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.segmented-row button {
  flex: 1;
  min-width: fit-content;
  padding: 6px 8px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 7px;
  background: var(--bg-color);
  font-size: 12px;
  transition:
    border-color 140ms,
    color 140ms;
}
.segmented-row button.active {
  border-color: var(--contrast-main-color);
  color: var(--contrast-main-color);
  font-weight: 600;
}
.segmented-row button:disabled {
  opacity: 0.45;
  cursor: default;
}
.field-hint {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.75;
}
.inline-link {
  margin-left: 6px;
  text-decoration: underline;
  color: var(--contrast-main-color);
}
.status-message {
  margin-top: 8px;
  font-size: 12px;
  color: var(--contrast-main-color);
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

.confirm-box {
  margin-top: 10px;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--contrast-border-color);
  background: color-mix(in srgb, var(--sub-alt-color) 70%, var(--bg-color));
  font-size: 12px;
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
  margin-top: 10px;
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
  min-width: 0;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
}
.series-references legend {
  font-weight: 600;
}
.series-reference-list {
  display: flex;
  max-width: 100%;
  overflow-x: auto;
  gap: 8px;
  padding: 2px 2px 4px;
}
.series-reference {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.series-reference img {
  width: 32px;
  height: 80px;
  object-fit: contain;
  background: var(--bg-color);
}
.generation-note {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.45;
  opacity: 0.78;
}

.check-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
  font-size: 12px;
}
.check-row label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}
.export-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.export-primary {
  flex: 1.3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 12px;
  border-radius: 8px;
  background: var(--main-color);
  color: var(--contrast-inverse-color);
  font-size: 13px;
  font-weight: 600;
}
.export-secondary {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--contrast-border-color);
  background: var(--bg-color);
  font-size: 13px;
  font-weight: 600;
}
.export-primary:disabled,
.export-secondary:disabled {
  opacity: 0.55;
  cursor: default;
}

.mini-cover-studio :is(button, input, textarea):focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
}
</style>
