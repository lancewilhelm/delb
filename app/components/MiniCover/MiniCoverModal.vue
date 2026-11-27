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
import { fetchBookDetail } from '~/utils/bookPreviewCache';
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

type SavedMiniCoverSettings = {
  spineSource: 'mini' | 'book' | 'plain';
  spineFit: MiniCoverSpineFit;
  spineOffset: number;
  backStyle: MiniCoverBackStyle;
  orientation: MiniCoverOrientation;
  resolution: MiniCoverResolution;
  bleedMm: MiniCoverBleedMm;
  foldMarks: boolean;
  trimMarks: boolean;
};

type MiniCoverResponse = {
  hasSpine: boolean;
  spineRevision: string | null;
  spineEdits: unknown;
  settings: SavedMiniCoverSettings | null;
  updatedAt: string | null;
};

type SpineSourceKind = 'mini' | 'book' | 'uploaded' | 'generated' | 'plain';
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

// Loaded book + cover
const loading = ref(false);
const loadError = ref<string | null>(null);
const book = shallowRef<BookSummary | null>(null);
const coverAsset = shallowRef<MiniCoverImageSource | null>(null);
const coverFailed = ref(false);
const palette = shallowRef<CardPalette>(paletteFromHex(null));

// Separate saved mini-cover spine (stored in book_mini_covers / mini-spine.webp)
const miniSpineRevision = ref<string | null>(null);
const miniSpineAsset = shallowRef<MiniCoverImageSource | null>(null);
const miniSpineError = ref<string | null>(null);

// Book's regular bookshelf/detail spine (read-only reference here)
const bookSpineRevision = ref<string | null>(null);
const bookSpineAsset = shallowRef<MiniCoverImageSource | null>(null);
const bookSpineError = ref<string | null>(null);

// Session-staged uploaded & generated spines
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

// Persistence for mini-cover spine + settings
const savingMiniCover = ref(false);
const removingMiniSpine = ref(false);
const saveStatusMessage = ref<string | null>(null);
const saveConflict = ref(false);
const savedSettingsJson = ref<string | null>(null);

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
const foldedYaw = ref(-28);
let foldDrag: { pointerId: number; x: number; startYaw: number } | null = null;
let offscreenExportCanvas: HTMLCanvasElement | null = null;
let offscreenFoldedCanvas: HTMLCanvasElement | null = null;
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
  if (spineSource.value === 'mini') return miniSpineAsset.value;
  if (spineSource.value === 'book') return bookSpineAsset.value;
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

const hasReferenceSpineForGeneration = computed(
  () =>
    activeSpineImage.value !== null ||
    miniSpineAsset.value !== null ||
    bookSpineAsset.value !== null ||
    generatedSpine.value !== null ||
    uploadedSpine.value !== null,
);

const seriesSelectionLimit = computed(
  () =>
    MAX_SERIES_SPINE_REFERENCES -
    (hasReferenceSpineForGeneration.value ? 1 : 0),
);

const hasUnsavedLocalSpine = computed(
  () =>
    (spineSource.value === 'uploaded' && Boolean(uploadedSpine.value)) ||
    (spineSource.value === 'generated' && Boolean(generatedSpine.value)),
);

function buildCurrentSettingsPayload(
  sourceOverride?: 'mini' | 'book' | 'plain',
): SavedMiniCoverSettings {
  const persistedSource: 'mini' | 'book' | 'plain' =
    sourceOverride ??
    (spineSource.value === 'mini' ||
    spineSource.value === 'book' ||
    spineSource.value === 'plain'
      ? spineSource.value
      : miniSpineAsset.value
        ? 'mini'
        : bookSpineAsset.value
          ? 'book'
          : 'plain');

  return {
    spineSource: persistedSource,
    spineFit: spineFit.value,
    spineOffset: Math.round(spineOffset.value * 100) / 100,
    backStyle: backStyle.value,
    orientation: orientation.value,
    resolution: resolution.value,
    bleedMm: bleedMm.value,
    foldMarks: foldMarks.value,
    trimMarks: trimMarks.value,
  };
}

const currentSettingsJson = computed(() =>
  JSON.stringify(buildCurrentSettingsPayload()),
);

const settingsDirty = computed(() => {
  if (hasUnsavedLocalSpine.value) return true;
  if (savedSettingsJson.value == null) return false;
  return currentSettingsJson.value !== savedSettingsJson.value;
});

const subtitleText = computed(() =>
  orientation.value === 'ltr'
    ? `${MINI_COVER_MM.totalWidth} × ${MINI_COVER_MM.height} mm wrap · cover (20 mm), spine (10 mm), cover (20 mm)`
    : `${MINI_COVER_MM.totalWidth} × ${MINI_COVER_MM.height} mm wrap · front (20 mm), spine (10 mm), back (20 mm)`,
);

const fileName = computed(() =>
  miniCoverFileName(book.value?.title ?? 'book', resolution.value),
);

const flatPreviewWidthStyle = computed(() => {
  if (actualSize.value) {
    const totalMm =
      MINI_COVER_MM.totalWidth + bleedMm.value * 2 + layout.value.marginMm * 2;
    return `${Math.round((totalMm * 96) / 25.4)}px`;
  }
  return `${Math.round((460 * zoom.value) / 100)}px`;
});

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

// 3D folded mini book geometry (20 × 10 × 30 mm scaled at 7 px/mm with rounded spine shoulders)
const FOLD_H = 210; // 30 mm
const FOLD_D = 140; // 20 mm cover depth
const FOLD_W = 70; // 10 mm spine width
const FOLD_R = 11; // ~1.6 mm spine edge radius
const FOLD_SHOULDER_SEGMENTS = 6;
const FOLD_FLAT_SPINE_W = FOLD_W - FOLD_R * 2;
const FOLD_COVER_W = FOLD_D - FOLD_R;
const FOLD_ARC_LEN = (Math.PI / 2) * FOLD_R;
const FOLD_SURFACE_LEN =
  FOLD_COVER_W * 2 + FOLD_ARC_LEN * 2 + FOLD_FLAT_SPINE_W;

type FoldedPanelStyle = {
  key: string;
  style: Record<string, string>;
};

const foldedPanels = computed<{
  leftCover: Record<string, string>;
  rightCover: Record<string, string>;
  spineFlat: Record<string, string>;
  leftShoulder: FoldedPanelStyle[];
  rightShoulder: FoldedPanelStyle[];
}>(() => {
  const imgUrl = foldedDataUrl.value ? `url("${foldedDataUrl.value}")` : 'none';
  const bgSize = `${FOLD_SURFACE_LEN.toFixed(2)}px ${FOLD_H}px`;
  const halfD = FOLD_D / 2;
  const halfW = FOLD_W / 2;
  const arcCenterZ = halfD - FOLD_R;
  const arcCenterX = halfW - FOLD_R;
  const segAngleDeg = 90 / FOLD_SHOULDER_SEGMENTS;
  const segAngleRad = (segAngleDeg * Math.PI) / 180;
  const chordW = 2 * FOLD_R * Math.sin(segAngleRad / 2);
  const segArcLen = FOLD_ARC_LEN / FOLD_SHOULDER_SEGMENTS;
  const overlapPx = 0.55;
  const stripW = chordW + overlapPx * 2;
  const radiusMid = FOLD_R * Math.cos(segAngleRad / 2);

  const layerBg = (shade: string, uStartPx: number) => ({
    backgroundImage: imgUrl === 'none' ? shade : `${shade}, ${imgUrl}`,
    backgroundSize: imgUrl === 'none' ? '100% 100%' : `100% 100%, ${bgSize}`,
    backgroundPosition:
      imgUrl === 'none' ? '0 0' : `0 0, ${(-uStartPx).toFixed(2)}px 0px`,
    backgroundRepeat: 'no-repeat',
  });

  // Left cover runs from u = 0 to u = FOLD_COVER_W (x = -halfW, z from -halfD to +arcCenterZ)
  const coverCenterZ = (-halfD + arcCenterZ) / 2;
  const leftCover: Record<string, string> = {
    width: `${FOLD_COVER_W}px`,
    height: `${FOLD_H}px`,
    marginLeft: `${(-FOLD_COVER_W / 2).toFixed(2)}px`,
    transform: `translate3d(${(-halfW).toFixed(2)}px, 0, ${coverCenterZ.toFixed(2)}px) rotateY(-90deg)`,
    ...layerBg(
      'linear-gradient(90deg, rgba(0,0,0,0.06), rgba(255,255,255,0.04) 85%, rgba(0,0,0,0.12))',
      0,
    ),
  };

  // Left rounded shoulder: 6 segments going left-to-right from -90deg (left cover) to 0deg (spine)
  const leftShoulder: FoldedPanelStyle[] = [];
  for (let i = 0; i < FOLD_SHOULDER_SEGMENTS; i++) {
    const t = (i + 0.5) / FOLD_SHOULDER_SEGMENTS; // 0 = left cover edge, 1 = spine edge
    const angleDeg = -90 * (1 - t);
    const angleRad = (angleDeg * Math.PI) / 180;
    const mx = -arcCenterX + radiusMid * Math.sin(angleRad);
    const mz = arcCenterZ + radiusMid * Math.cos(angleRad);
    const uStart = FOLD_COVER_W + i * segArcLen - overlapPx;
    const highlight = Math.max(0, Math.sin(t * Math.PI) * 0.16);
    const shadow = (1 - t) * 0.14;
    const shade = `linear-gradient(90deg, rgba(0,0,0,${shadow.toFixed(3)}), rgba(255,255,255,${highlight.toFixed(3)}))`;
    leftShoulder.push({
      key: `ls-${i}`,
      style: {
        width: `${stripW.toFixed(2)}px`,
        height: `${FOLD_H}px`,
        marginLeft: `${(-stripW / 2).toFixed(2)}px`,
        transform: `translate3d(${mx.toFixed(2)}px, 0, ${mz.toFixed(2)}px) rotateY(${angleDeg.toFixed(2)}deg)`,
        ...layerBg(shade, uStart),
      },
    });
  }

  // Flat spine center: u from FOLD_COVER_W + FOLD_ARC_LEN across FOLD_FLAT_SPINE_W
  const spineStartU = FOLD_COVER_W + FOLD_ARC_LEN;
  const spinePad = 0.4;
  const spineFlat: Record<string, string> = {
    width: `${(FOLD_FLAT_SPINE_W + spinePad * 2).toFixed(2)}px`,
    height: `${FOLD_H}px`,
    marginLeft: `${(-(FOLD_FLAT_SPINE_W / 2 + spinePad)).toFixed(2)}px`,
    transform: `translate3d(0, 0, ${halfD}px)`,
    ...layerBg(
      'linear-gradient(90deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02) 35%, rgba(0,0,0,0) 70%, rgba(0,0,0,0.08))',
      spineStartU - spinePad,
    ),
  };

  // Right rounded shoulder: 6 segments going left-to-right from 0deg (spine) to +90deg (right cover)
  const rightShoulder: FoldedPanelStyle[] = [];
  const rightShoulderStartU = spineStartU + FOLD_FLAT_SPINE_W;
  for (let i = 0; i < FOLD_SHOULDER_SEGMENTS; i++) {
    const t = (i + 0.5) / FOLD_SHOULDER_SEGMENTS; // 0 = spine edge, 1 = right cover edge
    const angleDeg = 90 * t;
    const angleRad = (angleDeg * Math.PI) / 180;
    const mx = arcCenterX + radiusMid * Math.sin(angleRad);
    const mz = arcCenterZ + radiusMid * Math.cos(angleRad);
    const uStart = rightShoulderStartU + i * segArcLen - overlapPx;
    const highlight = Math.max(0, Math.sin(t * Math.PI) * 0.1);
    const shadow = t * 0.18;
    const shade = `linear-gradient(90deg, rgba(255,255,255,${highlight.toFixed(3)}), rgba(0,0,0,${shadow.toFixed(3)}))`;
    rightShoulder.push({
      key: `rs-${i}`,
      style: {
        width: `${stripW.toFixed(2)}px`,
        height: `${FOLD_H}px`,
        marginLeft: `${(-stripW / 2).toFixed(2)}px`,
        transform: `translate3d(${mx.toFixed(2)}px, 0, ${mz.toFixed(2)}px) rotateY(${angleDeg.toFixed(2)}deg)`,
        ...layerBg(shade, uStart),
      },
    });
  }

  // Right cover runs from u = rightShoulderStartU + FOLD_ARC_LEN to FOLD_SURFACE_LEN
  const rightCoverStartU = rightShoulderStartU + FOLD_ARC_LEN;
  const rightCover: Record<string, string> = {
    width: `${FOLD_COVER_W}px`,
    height: `${FOLD_H}px`,
    marginLeft: `${(-FOLD_COVER_W / 2).toFixed(2)}px`,
    transform: `translate3d(${halfW.toFixed(2)}px, 0, ${coverCenterZ.toFixed(2)}px) rotateY(90deg)`,
    ...layerBg(
      'linear-gradient(90deg, rgba(0,0,0,0.12), rgba(255,255,255,0.04) 15%, rgba(0,0,0,0.05))',
      rightCoverStartU,
    ),
  };

  return {
    leftCover,
    rightCover,
    spineFlat,
    leftShoulder,
    rightShoulder,
  };
});

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

async function loadBookSpine(bookId: string, token: number) {
  bookSpineError.value = null;
  bookSpineAsset.value = null;
  bookSpineRevision.value = null;
  try {
    const meta = await $fetch<{
      exists: boolean;
      revision: string | null;
    }>(`/api/books/${encodeURIComponent(bookId)}/spine?variant=metadata`);
    if (token !== loadToken) return;
    if (!meta.exists || !meta.revision) return;
    bookSpineRevision.value = meta.revision;
    const img = await loadImage(
      `/api/books/${encodeURIComponent(bookId)}/spine?v=${encodeURIComponent(meta.revision)}`,
    );
    if (token !== loadToken) return;
    bookSpineAsset.value = {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      edgeColor: sampleEdgeColor(img),
    };
  } catch {
    if (token !== loadToken) return;
    bookSpineError.value = 'Could not load the book’s bookshelf spine.';
  }
}

async function loadSavedMiniCover(
  bookId: string,
  token: number,
): Promise<SavedMiniCoverSettings | null> {
  miniSpineError.value = null;
  miniSpineAsset.value = null;
  miniSpineRevision.value = null;
  try {
    const res = await $fetch<MiniCoverResponse>(
      `/api/books/${encodeURIComponent(bookId)}/mini-cover`,
    );
    if (token !== loadToken) return null;
    if (res.hasSpine && res.spineRevision) {
      miniSpineRevision.value = res.spineRevision;
      try {
        const img = await loadImage(
          `/api/books/${encodeURIComponent(bookId)}/mini-cover/spine?v=${encodeURIComponent(res.spineRevision)}`,
        );
        if (token !== loadToken) return null;
        miniSpineAsset.value = {
          image: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
          edgeColor: sampleEdgeColor(img),
        };
      } catch {
        if (token !== loadToken) return null;
        miniSpineError.value = 'Could not load the saved mini cover spine.';
      }
    }
    return res.settings;
  } catch {
    if (token !== loadToken) return null;
    miniSpineError.value = 'Could not load saved mini cover settings.';
    return null;
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
  miniSpineAsset.value = null;
  miniSpineRevision.value = null;
  miniSpineError.value = null;
  bookSpineAsset.value = null;
  bookSpineRevision.value = null;
  bookSpineError.value = null;
  savedSettingsJson.value = null;
  clearSessionAssets();

  // Reset layout controls to defaults before restoring saved settings
  backStyle.value = 'same';
  orientation.value = 'ltr';
  resolution.value = 'high';
  bleedMm.value = 0;
  foldMarks.value = true;
  trimMarks.value = false;
  spineFit.value = 'crop';
  spineOffset.value = 0;
  previewMode.value = 'flat';
  actualSize.value = false;
  zoom.value = 100;
  foldedYaw.value = -28;
  foldedDataUrl.value = null;

  try {
    const loaded = (await fetchBookDetail(bookId)) as BookSummary | null;
    if (token !== loadToken) return;
    if (!loaded) {
      loadError.value = 'Book not found.';
      return;
    }
    book.value = loaded;

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

    const [savedSettings] = await Promise.all([
      loadSavedMiniCover(loaded.id, token),
      loadBookSpine(loaded.id, token),
      coverPromise,
      loaded.canEdit ? loadEditorExtras(loaded.id, token) : Promise.resolve(),
    ]);
    if (token !== loadToken) return;

    if (savedSettings) {
      backStyle.value = savedSettings.backStyle;
      orientation.value = savedSettings.orientation;
      resolution.value = savedSettings.resolution;
      bleedMm.value = savedSettings.bleedMm;
      foldMarks.value = savedSettings.foldMarks;
      trimMarks.value = savedSettings.trimMarks;
      spineFit.value = savedSettings.spineFit;
      spineOffset.value = savedSettings.spineOffset;

      if (savedSettings.spineSource === 'mini' && miniSpineAsset.value) {
        spineSource.value = 'mini';
      } else if (savedSettings.spineSource === 'book' && bookSpineAsset.value) {
        spineSource.value = 'book';
      } else if (savedSettings.spineSource === 'plain') {
        spineSource.value = 'plain';
      } else {
        spineSource.value = miniSpineAsset.value
          ? 'mini'
          : bookSpineAsset.value
            ? 'book'
            : 'plain';
      }
      savedSettingsJson.value = JSON.stringify(buildCurrentSettingsPayload());
    } else {
      spineSource.value = miniSpineAsset.value
        ? 'mini'
        : bookSpineAsset.value
          ? 'book'
          : 'plain';
      applyRecommendedFit();
      savedSettingsJson.value = JSON.stringify(buildCurrentSettingsPayload());
    }
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

function buildRenderSources(b: BookSummary) {
  return {
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
  };
}

function renderToCanvas(
  el: HTMLCanvasElement,
  targetLayout: ReturnType<typeof layoutMiniCover>,
  b: BookSummary,
  marks: { foldMarks: boolean; trimMarks: boolean },
): boolean {
  if (el.width !== targetLayout.width) el.width = targetLayout.width;
  if (el.height !== targetLayout.height) el.height = targetLayout.height;
  const ctx = el.getContext('2d');
  if (!ctx) return false;
  renderMiniCover(ctx, targetLayout, buildRenderSources(b), marks);
  return true;
}

function renderExportCanvas(): HTMLCanvasElement | null {
  const b = book.value;
  if (!b || loading.value || loadError.value) return null;
  const target =
    canvasRef.value ??
    (offscreenExportCanvas ??= document.createElement('canvas'));
  const ok = renderToCanvas(target, layout.value, b, {
    foldMarks: foldMarks.value,
    trimMarks: effectiveTrimMarks.value,
  });
  return ok ? target : null;
}

function draw() {
  const b = book.value;
  if (!b || loading.value || loadError.value) return;

  if (canvasRef.value) {
    renderToCanvas(canvasRef.value, layout.value, b, {
      foldMarks: foldMarks.value,
      trimMarks: effectiveTrimMarks.value,
    });
  }

  if (previewMode.value === 'folded') {
    const foldedCanvas = (offscreenFoldedCanvas ??=
      document.createElement('canvas'));
    const cleanLayout = layoutMiniCover({
      pxPerMm: 12,
      bleedMm: 0,
      trimMarks: false,
      orientation: orientation.value,
    });
    if (
      renderToCanvas(foldedCanvas, cleanLayout, b, {
        foldMarks: false,
        trimMarks: false,
      })
    ) {
      try {
        foldedDataUrl.value = foldedCanvas.toDataURL('image/png');
      } catch {
        foldedDataUrl.value = null;
      }
    }
  }
}

watch(
  [
    book,
    coverAsset,
    miniSpineAsset,
    bookSpineAsset,
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
  if (next === 'mini' && !miniSpineAsset.value) return;
  if (next === 'book' && !bookSpineAsset.value) return;
  if (next === 'uploaded' && !uploadedSpine.value) return;
  if (next === 'generated' && !generatedSpine.value) return;
  trimMode.value = false;
  saveStatusMessage.value = null;
  spineSource.value = next;
  applyRecommendedFit();
}

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

async function getReferenceSpineFileForGeneration(): Promise<File | null> {
  if (spineSource.value === 'generated' && generatedSpine.value) {
    return generatedSpine.value.file;
  }
  if (spineSource.value === 'uploaded' && uploadedSpine.value) {
    return uploadedSpine.value.file;
  }
  if (book.value && spineSource.value === 'mini' && miniSpineRevision.value) {
    try {
      const res = await fetch(
        `/api/books/${encodeURIComponent(book.value.id)}/mini-cover/spine?v=${encodeURIComponent(miniSpineRevision.value)}`,
      );
      if (res.ok) {
        const blob = await res.blob();
        return new File([blob], 'mini-spine.webp', {
          type: blob.type || 'image/webp',
        });
      }
    } catch {
      return null;
    }
  }
  if (book.value && bookSpineRevision.value) {
    try {
      const res = await fetch(
        `/api/books/${encodeURIComponent(book.value.id)}/spine?v=${encodeURIComponent(bookSpineRevision.value)}`,
      );
      if (res.ok) {
        const blob = await res.blob();
        return new File([blob], 'book-spine.webp', {
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
  foldedYaw.value = Math.max(
    -120,
    Math.min(120, foldDrag.startYaw + dx * 0.45),
  );
}

function keyFoldRotate(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    foldedYaw.value = Math.max(-120, foldedYaw.value - 10);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    foldedYaw.value = Math.min(120, foldedYaw.value + 10);
  }
}

function stopFoldRotate(event: PointerEvent) {
  if (foldDrag?.pointerId === event.pointerId) foldDrag = null;
}

// Save dedicated mini-cover spine + settings (separate from the bookshelf spine)
async function saveMiniSpineAndSettings() {
  const b = book.value;
  const asset = activeStagedAsset.value;
  if (!b || !asset || !canEdit.value || savingMiniCover.value) return;

  savingMiniCover.value = true;
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
    const settingsPayload = buildCurrentSettingsPayload('mini');
    settingsPayload.spineOffset = 0;

    const body = new FormData();
    body.append('file', asset.file);
    body.append('revision', miniSpineRevision.value ?? '');
    body.append('edits', JSON.stringify(edits));
    body.append('settings', JSON.stringify(settingsPayload));

    const result = await $fetch<{ revision: string }>(
      `/api/books/${encodeURIComponent(b.id)}/mini-cover/spine`,
      { method: 'POST', body },
    );

    miniSpineRevision.value = result.revision;
    const img = await loadImage(
      `/api/books/${encodeURIComponent(b.id)}/mini-cover/spine?v=${encodeURIComponent(result.revision)}`,
    );
    miniSpineAsset.value = {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      edgeColor: sampleEdgeColor(img),
    };

    if (spineSource.value === 'uploaded') {
      revokeAsset(uploadedSpine.value);
      uploadedSpine.value = null;
    } else if (spineSource.value === 'generated') {
      revokeAsset(generatedSpine.value);
      generatedSpine.value = null;
    }
    spineSource.value = 'mini';
    spineOffset.value = 0;
    trimMode.value = false;
    savedSettingsJson.value = JSON.stringify(
      buildCurrentSettingsPayload('mini'),
    );
    saveStatusMessage.value =
      'Saved mini cover spine & settings (bookshelf spine unchanged).';
  } catch (cause: unknown) {
    const isConflict =
      typeof cause === 'object' &&
      cause !== null &&
      'statusCode' in cause &&
      cause.statusCode === 409;
    if (isConflict) {
      saveConflict.value = true;
      spineError.value =
        'This book’s mini cover spine changed elsewhere. Reload it before saving, or keep downloading your local export.';
    } else {
      spineError.value =
        'Could not save the mini cover spine. Your local preview is still ready to export.';
    }
  } finally {
    savingMiniCover.value = false;
  }
}

async function saveMiniCoverSettingsOnly() {
  const b = book.value;
  if (!b || !canEdit.value || savingMiniCover.value) return;

  savingMiniCover.value = true;
  spineError.value = null;
  saveStatusMessage.value = null;

  try {
    const payload = buildCurrentSettingsPayload();
    await $fetch(`/api/books/${encodeURIComponent(b.id)}/mini-cover`, {
      method: 'PUT',
      body: { settings: payload },
    });
    savedSettingsJson.value = JSON.stringify(payload);
    saveStatusMessage.value = 'Saved mini cover settings.';
  } catch {
    spineError.value = 'Could not save mini cover settings.';
  } finally {
    savingMiniCover.value = false;
  }
}

async function removeSavedMiniSpine() {
  const b = book.value;
  if (
    !b ||
    !canEdit.value ||
    !miniSpineRevision.value ||
    removingMiniSpine.value
  )
    return;

  removingMiniSpine.value = true;
  spineError.value = null;
  saveStatusMessage.value = null;
  saveConflict.value = false;

  try {
    await $fetch(`/api/books/${encodeURIComponent(b.id)}/mini-cover/spine`, {
      method: 'DELETE',
      body: { revision: miniSpineRevision.value },
    });
    miniSpineRevision.value = null;
    miniSpineAsset.value = null;
    if (spineSource.value === 'mini') {
      spineSource.value = bookSpineAsset.value ? 'book' : 'plain';
      applyRecommendedFit();
    }
    saveStatusMessage.value = 'Removed saved mini cover spine.';
  } catch (cause: unknown) {
    const isConflict =
      typeof cause === 'object' &&
      cause !== null &&
      'statusCode' in cause &&
      cause.statusCode === 409;
    if (isConflict) {
      saveConflict.value = true;
      spineError.value =
        'This mini cover spine changed elsewhere. Reload before removing.';
    } else {
      spineError.value = 'Could not remove the saved mini cover spine.';
    }
  } finally {
    removingMiniSpine.value = false;
  }
}

async function reloadMiniCoverAfterConflict() {
  if (!book.value) return;
  saveConflict.value = false;
  spineError.value = null;
  await loadSavedMiniCover(book.value.id, loadToken);
}

// Export actions
async function onDownload() {
  if (exportBusy.value) return;
  const el = renderExportCanvas();
  if (!el) return;
  exportBusy.value = 'download';
  actionMessage.value = null;
  actionError.value = null;
  try {
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
  if (exportBusy.value || !copySupported) return;
  const el = renderExportCanvas();
  if (!el) return;
  exportBusy.value = 'copy';
  actionMessage.value = null;
  actionError.value = null;
  try {
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
                aria-label="3D folded mini book preview. Drag horizontally or use arrow keys to rotate."
                @pointerdown="startFoldRotate"
                @pointermove="moveFoldRotate"
                @pointerup="stopFoldRotate"
                @pointercancel="stopFoldRotate"
                @keydown="keyFoldRotate"
              >
                <div
                  class="mini-book-3d"
                  :style="{
                    transform: `rotateX(-11deg) rotateY(${foldedYaw}deg)`,
                  }"
                >
                  <div class="book-ground-shadow" aria-hidden="true" />
                  <div
                    class="book-face book-face-back"
                    :style="foldedPanels.leftCover"
                  />
                  <div
                    v-for="seg in foldedPanels.leftShoulder"
                    :key="seg.key"
                    class="book-face book-face-shoulder"
                    :style="seg.style"
                  />
                  <div
                    class="book-face book-face-spine"
                    :style="foldedPanels.spineFlat"
                  />
                  <div
                    v-for="seg in foldedPanels.rightShoulder"
                    :key="seg.key"
                    class="book-face book-face-shoulder"
                    :style="seg.style"
                  />
                  <div
                    class="book-face book-face-front"
                    :style="foldedPanels.rightCover"
                  />
                  <div class="book-face book-face-pages" />
                  <div class="book-face book-face-top-pages" />
                  <div class="book-face book-face-bottom-pages" />
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

                  <div
                    v-if="showGuides"
                    class="height-bracket"
                    aria-hidden="true"
                  >
                    <span>30 mm</span>
                  </div>
                </div>

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
                <h3>Mini spine (10 × 30 mm · 1:3)</h3>
                <p>
                  Saved separately from the book’s bookshelf spine so you can
                  tune 1:3 wraps independently.
                </p>
              </div>
              <Icon name="lucide:columns-3" aria-hidden="true" />
            </div>

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
                  miniSpineAsset || bookSpineAsset
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
                trims about {{ Math.max(0.5, spineRatio.trimMm).toFixed(1) }}
                mm.
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
                    : 'Choose how to fit it below, or make a dedicated 1:3 mini spine.'
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

            <p v-if="miniSpineError" role="alert" class="studio-error">
              {{ miniSpineError }}
              <button
                type="button"
                @click="book && loadSavedMiniCover(book.id, loadToken)"
              >
                Retry
              </button>
            </p>

            <p v-if="bookSpineError" role="alert" class="studio-error">
              {{ bookSpineError }}
              <button
                type="button"
                @click="book && loadBookSpine(book.id, loadToken)"
              >
                Retry
              </button>
            </p>

            <p v-if="spineError" role="alert" class="studio-error">
              {{ spineError }}
              <button
                v-if="saveConflict"
                type="button"
                @click="reloadMiniCoverAfterConflict"
              >
                Reload mini spine
              </button>
            </p>

            <!-- Source switcher -->
            <fieldset class="field-group">
              <legend>Spine source</legend>
              <div class="segmented-row">
                <button
                  v-if="miniSpineAsset"
                  type="button"
                  :class="{ active: spineSource === 'mini' }"
                  :aria-pressed="spineSource === 'mini'"
                  title="Dedicated saved mini cover spine"
                  @click="selectSpineSource('mini')"
                >
                  Mini spine
                </button>
                <button
                  type="button"
                  :disabled="!bookSpineAsset"
                  :class="{ active: spineSource === 'book' }"
                  :aria-pressed="spineSource === 'book'"
                  :title="
                    bookSpineAsset
                      ? 'Use the book’s bookshelf spine'
                      : 'No bookshelf spine yet'
                  "
                  @click="selectSpineSource('book')"
                >
                  Book spine
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

            <!-- Upload + Trim + Save / Remove mini spine actions -->
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
                class="upload-action"
                :disabled="generating || savingMiniCover || trimMode"
                @click="saveMiniSpineAndSettings"
              >
                <Icon name="lucide:save" aria-hidden="true" />
                {{ savingMiniCover ? 'Saving…' : 'Save mini spine & settings' }}
              </button>
              <button
                v-if="canEdit && spineSource === 'mini' && miniSpineAsset"
                type="button"
                :disabled="generating || removingMiniSpine"
                @click="removeSavedMiniSpine"
              >
                <Icon name="lucide:trash-2" aria-hidden="true" />
                {{ removingMiniSpine ? 'Removing…' : 'Remove mini spine' }}
              </button>
            </div>
            <p v-if="hasUnsavedLocalSpine" class="field-hint">
              {{
                canEdit
                  ? 'Not saved yet — save to reuse this 1:3 spine later without changing the bookshelf spine.'
                  : 'Used for this export only.'
              }}
            </p>
            <p v-if="saveStatusMessage" role="status" class="status-message">
              {{ saveStatusMessage }}
            </p>

            <!-- Regenerate as 1:3 block -->
            <div ref="generateSectionRef" class="generation">
              <div class="controls-heading">
                <div>
                  <h3>Make a 1:3 mini spine</h3>
                  <p>
                    Experimental · Regenerates a 1:3 spine using the saved cover
                    and ChatGPT.
                  </p>
                </div>
                <Icon name="lucide:sparkles" aria-hidden="true" />
              </div>

              <p v-if="!canEdit" class="generation-note">
                Only people who can edit this book can generate or save mini
                spines. You can still upload any spine image above for this
                export.
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
          Unsaved {{ spineSource }} mini spine — save it to reuse later.
        </span>
        <span v-else-if="canEdit && settingsDirty" class="footer-note">
          Mini cover settings have unsaved changes.
        </span>
        <span v-else class="footer-note">
          20 × 10 × 30 mm miniature wrap (50 × 30 mm flat)
        </span>
        <div class="footer-actions">
          <button
            v-if="canEdit && hasUnsavedLocalSpine"
            type="button"
            class="footer-secondary"
            :disabled="savingMiniCover || generating || trimMode"
            @click="saveMiniSpineAndSettings"
          >
            {{ savingMiniCover ? 'Saving…' : 'Save mini spine' }}
          </button>
          <button
            v-else-if="canEdit && settingsDirty"
            type="button"
            class="footer-secondary"
            :disabled="savingMiniCover || generating"
            @click="saveMiniCoverSettingsOnly"
          >
            {{ savingMiniCover ? 'Saving…' : 'Save settings' }}
          </button>
          <button type="button" class="footer-primary" @click="close">
            Done
          </button>
        </div>
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
.footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.footer-primary {
  padding: 8px 16px;
  border-radius: 7px;
  background: var(--main-color);
  color: var(--contrast-inverse-color);
  font-size: 13px;
  font-weight: 600;
}
.footer-secondary {
  padding: 7px 13px;
  border-radius: 7px;
  border: 1px solid var(--contrast-main-color);
  color: var(--contrast-main-color);
  background: var(--bg-color);
  font-size: 13px;
  font-weight: 600;
}
.footer-secondary:disabled {
  opacity: 0.5;
  cursor: default;
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

.folded-stage {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  perspective: 920px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.folded-stage:active {
  cursor: grabbing;
}
.mini-book-3d {
  position: relative;
  width: 70px;
  height: 210px;
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
  top: 0;
  left: 50%;
  backface-visibility: hidden;
  background-repeat: no-repeat;
  transform-origin: center center;
}
.book-face-spine,
.book-face-shoulder {
  box-shadow: none;
}
.book-face-front {
  border-radius: 0 3px 3px 0;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
}
.book-face-back {
  border-radius: 3px 0 0 3px;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
}
.book-face-pages {
  width: 64px;
  height: 204px;
  top: 3px;
  margin-left: -32px;
  transform: translate3d(0, 0, -68px) rotateY(180deg);
  background: repeating-linear-gradient(
    90deg,
    #f5f1e7 0px,
    #f5f1e7 2px,
    #e4dfd2 3px
  );
  box-shadow: inset 0 0 6px rgb(0 0 0 / 16%);
}
.book-face-top-pages {
  width: 66px;
  height: 136px;
  top: 2px;
  margin-left: -33px;
  transform-origin: center center;
  transform: translate3d(0, -68px, 0) rotateX(90deg);
  border-radius: 0 0 10px 10px;
  background: repeating-linear-gradient(
    90deg,
    #f7f3ea 0px,
    #f7f3ea 2px,
    #e5dfd1 3px
  );
  box-shadow: inset 0 0 5px rgb(0 0 0 / 14%);
}
.book-face-bottom-pages {
  width: 66px;
  height: 136px;
  top: 208px;
  margin-left: -33px;
  transform-origin: center center;
  transform: translate3d(0, -68px, 0) rotateX(-90deg);
  border-radius: 10px 10px 0 0;
  background: repeating-linear-gradient(
    90deg,
    #ebe6da 0px,
    #ebe6da 2px,
    #dcd5c5 3px
  );
  box-shadow: inset 0 0 5px rgb(0 0 0 / 18%);
}
.book-ground-shadow {
  position: absolute;
  width: 112px;
  height: 168px;
  top: 218px;
  left: 50%;
  margin-left: -56px;
  transform: translate3d(0, -84px, 0) rotateX(90deg);
  border-radius: 18px;
  background: radial-gradient(
    ellipse at center,
    rgb(0 0 0 / 32%) 0%,
    rgb(0 0 0 / 12%) 52%,
    transparent 74%
  );
  pointer-events: none;
}

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
