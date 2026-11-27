/**
 * Pure geometry and layout math for 20 × 10 × 30 mm miniature book covers.
 *
 * Kept free of DOM references so both the single-book modal and a future
 * multi-book print sheet layout can share the exact same measurements.
 */

export const MINI_COVER_MM = {
  coverWidth: 20,
  spineWidth: 10,
  height: 30,
  totalWidth: 50,
} as const;

export const MINI_COVER_RESOLUTIONS = [
  {
    value: 'standard',
    label: 'Standard (300 dpi)',
    pxPerMm: 12,
    dpiTag: '300dpi',
  },
  {
    value: 'high',
    label: 'High (600 dpi)',
    pxPerMm: 24,
    dpiTag: '600dpi',
  },
] as const;

export type MiniCoverResolution =
  (typeof MINI_COVER_RESOLUTIONS)[number]['value'];

export const MINI_COVER_BLEEDS = [0, 1, 2] as const;
export type MiniCoverBleedMm = (typeof MINI_COVER_BLEEDS)[number];

export type MiniCoverOrientation = 'ltr' | 'rtl';
export type MiniCoverBackStyle = 'same' | 'solid' | 'blur';
export type MiniCoverSpineFit = 'crop' | 'fit' | 'stretch';

export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type CropInsets = {
  /** Percentage cropped from each edge (0..90). */
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export const FULL_CROP_INSETS: CropInsets = {
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
};

export type MiniCoverLayoutOptions = {
  pxPerMm: number;
  bleedMm: MiniCoverBleedMm;
  trimMarks: boolean;
  orientation: MiniCoverOrientation;
};

export type MiniCoverLayout = {
  width: number;
  height: number;
  pxPerMm: number;
  bleedMm: MiniCoverBleedMm;
  bleedPx: number;
  marginMm: number;
  marginPx: number;
  /** The exact 50 × 30 mm finished wrap rectangle inside the canvas. */
  trimRect: Rect;
  /** The painted artwork bounds (trimRect expanded by bleedPx on every side). */
  artworkRect: Rect;
  /** Finished panel rectangles inside trimRect. */
  panels: {
    left: Rect;
    spine: Rect;
    right: Rect;
    back: Rect;
    front: Rect;
  };
  /** Artwork rectangles expanded into the bleed on outer edges. */
  bleedPanels: {
    left: Rect;
    spine: Rect;
    right: Rect;
  };
  /** X coordinates of the two vertical fold lines (left-spine, spine-right). */
  folds: [number, number];
};

const TRIM_MARK_MARGIN_MM = 3;

export function resolutionConfig(resolution: MiniCoverResolution) {
  return (
    MINI_COVER_RESOLUTIONS.find((r) => r.value === resolution) ??
    MINI_COVER_RESOLUTIONS[1]
  );
}

export function layoutMiniCover(opts: MiniCoverLayoutOptions): MiniCoverLayout {
  const pxPerMm = opts.pxPerMm;
  const bleedMm = opts.bleedMm;
  const bleedPx = Math.round(bleedMm * pxPerMm);
  const marginMm = bleedMm > 0 && opts.trimMarks ? TRIM_MARK_MARGIN_MM : 0;
  const marginPx = Math.round(marginMm * pxPerMm);

  const coverW = Math.round(MINI_COVER_MM.coverWidth * pxPerMm);
  const spineW = Math.round(MINI_COVER_MM.spineWidth * pxPerMm);
  const wrapH = Math.round(MINI_COVER_MM.height * pxPerMm);
  const wrapW = coverW + spineW + coverW;

  const artworkX = marginPx;
  const artworkY = marginPx;
  const artworkW = wrapW + bleedPx * 2;
  const artworkH = wrapH + bleedPx * 2;

  const trimX = artworkX + bleedPx;
  const trimY = artworkY + bleedPx;

  const left: Rect = { x: trimX, y: trimY, w: coverW, h: wrapH };
  const spine: Rect = { x: trimX + coverW, y: trimY, w: spineW, h: wrapH };
  const right: Rect = {
    x: trimX + coverW + spineW,
    y: trimY,
    w: coverW,
    h: wrapH,
  };

  const bleedLeft: Rect = {
    x: artworkX,
    y: artworkY,
    w: coverW + bleedPx,
    h: artworkH,
  };
  const bleedSpine: Rect = {
    x: spine.x,
    y: artworkY,
    w: spineW,
    h: artworkH,
  };
  const bleedRight: Rect = {
    x: right.x,
    y: artworkY,
    w: coverW + bleedPx,
    h: artworkH,
  };

  const isRtl = opts.orientation === 'rtl';
  return {
    width: artworkW + marginPx * 2,
    height: artworkH + marginPx * 2,
    pxPerMm,
    bleedMm,
    bleedPx,
    marginMm,
    marginPx,
    trimRect: { x: trimX, y: trimY, w: wrapW, h: wrapH },
    artworkRect: { x: artworkX, y: artworkY, w: artworkW, h: artworkH },
    panels: {
      left,
      spine,
      right,
      back: isRtl ? right : left,
      front: isRtl ? left : right,
    },
    bleedPanels: {
      left: bleedLeft,
      spine: bleedSpine,
      right: bleedRight,
    },
    folds: [spine.x, right.x],
  };
}

/**
 * Computes source and destination rectangles for drawing a cropped source image
 * into a target rectangle using `crop` (cover), `fit` (contain), or `stretch`.
 * `offset` in [-1, 1] shifts the cropped window along whichever axis overflows.
 */
export function computeFitDrawRects(params: {
  sourceWidth: number;
  sourceHeight: number;
  crop?: CropInsets;
  target: Rect;
  mode: MiniCoverSpineFit;
  offset?: number;
}): { src: Rect; dst: Rect } {
  const crop = params.crop ?? FULL_CROP_INSETS;
  const sx = (params.sourceWidth * crop.left) / 100;
  const sy = (params.sourceHeight * crop.top) / 100;
  const sw = Math.max(
    1,
    (params.sourceWidth * (100 - crop.left - crop.right)) / 100,
  );
  const sh = Math.max(
    1,
    (params.sourceHeight * (100 - crop.top - crop.bottom)) / 100,
  );

  const { target, mode } = params;
  const clampedOffset = Math.max(-1, Math.min(1, params.offset ?? 0));

  if (mode === 'stretch') {
    return {
      src: { x: sx, y: sy, w: sw, h: sh },
      dst: { ...target },
    };
  }

  const srcAspect = sw / sh;
  const dstAspect = target.w / target.h;

  if (mode === 'crop') {
    if (srcAspect > dstAspect) {
      // Source is wider -> crop horizontally
      const visibleW = sh * dstAspect;
      const slack = Math.max(0, sw - visibleW);
      return {
        src: {
          x: sx + slack * (0.5 + clampedOffset * 0.5),
          y: sy,
          w: visibleW,
          h: sh,
        },
        dst: { ...target },
      };
    }
    // Source is taller -> crop vertically
    const visibleH = sw / dstAspect;
    const slack = Math.max(0, sh - visibleH);
    return {
      src: {
        x: sx,
        y: sy + slack * (0.5 + clampedOffset * 0.5),
        w: sw,
        h: visibleH,
      },
      dst: { ...target },
    };
  }

  // mode === 'fit' (contain)
  if (srcAspect > dstAspect) {
    const drawW = target.w;
    const drawH = target.w / srcAspect;
    return {
      src: { x: sx, y: sy, w: sw, h: sh },
      dst: {
        x: target.x,
        y: target.y + (target.h - drawH) / 2,
        w: drawW,
        h: drawH,
      },
    };
  }
  const drawH = target.h;
  const drawW = target.h * srcAspect;
  return {
    src: { x: sx, y: sy, w: sw, h: sh },
    dst: {
      x: target.x + (target.w - drawW) / 2,
      y: target.y,
      w: drawW,
      h: drawH,
    },
  };
}

/**
 * Converts a crop box around an arbitrary image into a centered 1:3 aspect
 * crop box (useful as the initial trim box after AI spine generation).
 * When pixel data is provided, detects uniform background borders first.
 */
export function suggestOneToThreeCrop(
  width: number,
  height: number,
  pixels?: Uint8ClampedArray | null,
): CropInsets {
  if (width <= 0 || height <= 0) return { ...FULL_CROP_INSETS };

  let minX = 0;
  let maxX = width - 1;
  let minY = 0;
  let maxY = height - 1;

  if (pixels && pixels.length >= width * height * 4) {
    // Sample the 4 corners to estimate a uniform backdrop color.
    const corners = [
      0,
      (width - 1) * 4,
      (height - 1) * width * 4,
      ((height - 1) * width + (width - 1)) * 4,
    ];
    let bgR = 0;
    let bgG = 0;
    let bgB = 0;
    for (const idx of corners) {
      bgR += pixels[idx]!;
      bgG += pixels[idx + 1]!;
      bgB += pixels[idx + 2]!;
    }
    bgR /= 4;
    bgG /= 4;
    bgB /= 4;

    const cornerSpread = corners.reduce((acc, idx) => {
      const dist =
        Math.abs(pixels[idx]! - bgR) +
        Math.abs(pixels[idx + 1]! - bgG) +
        Math.abs(pixels[idx + 2]! - bgB);
      return Math.max(acc, dist);
    }, 0);

    // Only attempt border detection when corners agree on a background color.
    if (cornerSpread < 45) {
      const diffThreshold = 34;
      const isForeground = (x: number, y: number) => {
        const i = (y * width + x) * 4;
        if (pixels[i + 3]! < 32) return false;
        const d =
          Math.abs(pixels[i]! - bgR) +
          Math.abs(pixels[i + 1]! - bgG) +
          Math.abs(pixels[i + 2]! - bgB);
        return d > diffThreshold;
      };

      const colHasFg = (x: number) => {
        let hits = 0;
        const step = Math.max(1, Math.floor(height / 40));
        for (let y = 0; y < height; y += step) {
          if (isForeground(x, y)) hits++;
        }
        return hits >= 3;
      };
      const rowHasFg = (y: number) => {
        let hits = 0;
        const step = Math.max(1, Math.floor(width / 40));
        for (let x = 0; x < width; x += step) {
          if (isForeground(x, y)) hits++;
        }
        return hits >= 3;
      };

      let foundLeft = 0;
      while (foundLeft < width - 1 && !colHasFg(foundLeft)) foundLeft++;
      let foundRight = width - 1;
      while (foundRight > foundLeft && !colHasFg(foundRight)) foundRight--;
      let foundTop = 0;
      while (foundTop < height - 1 && !rowHasFg(foundTop)) foundTop++;
      let foundBottom = height - 1;
      while (foundBottom > foundTop && !rowHasFg(foundBottom)) foundBottom--;

      const bw = foundRight - foundLeft + 1;
      const bh = foundBottom - foundTop + 1;
      if (bw >= width * 0.12 && bh >= height * 0.35) {
        minX = foundLeft;
        maxX = foundRight;
        minY = foundTop;
        maxY = foundBottom;
      }
    }
  }

  // Fit the largest 1:3 rectangle centered inside [minX..maxX, minY..maxY]
  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const targetRatio = 1 / 3;
  let cropW = boxW;
  let cropH = boxH;

  if (boxW / boxH > targetRatio) {
    cropW = boxH * targetRatio;
  } else {
    cropH = boxW / targetRatio;
  }

  const cx = minX + boxW / 2;
  const cy = minY + boxH / 2;
  const x0 = Math.max(0, Math.min(width - cropW, cx - cropW / 2));
  const y0 = Math.max(0, Math.min(height - cropH, cy - cropH / 2));
  const x1 = Math.min(width, x0 + cropW);
  const y1 = Math.min(height, y0 + cropH);

  const round1 = (n: number) =>
    Math.max(0, Math.min(90, Math.round(n * 10) / 10));
  return {
    left: round1((x0 / width) * 100),
    right: round1(((width - x1) / width) * 100),
    top: round1((y0 / height) * 100),
    bottom: round1(((height - y1) / height) * 100),
  };
}

/**
 * Converts a spine crop offset in crop mode into SpineEdits percentages so
 * "Save spine to book" preserves the exact framing shown in the preview.
 */
export function buildSpineEditsForSave(params: {
  sourceWidth: number;
  sourceHeight: number;
  crop: CropInsets;
  fit: MiniCoverSpineFit;
  offset: number;
}): {
  left: number;
  right: number;
  top: number;
  bottom: number;
  stretch: boolean;
} {
  const { sourceWidth, sourceHeight, crop, fit, offset } = params;
  const round1 = (n: number) =>
    Math.max(0, Math.min(90, Math.round(n * 10) / 10));

  if (fit === 'stretch') {
    return {
      left: round1(crop.left),
      right: round1(crop.right),
      top: round1(crop.top),
      bottom: round1(crop.bottom),
      stretch: true,
    };
  }
  if (fit === 'fit' || sourceWidth <= 0 || sourceHeight <= 0) {
    return {
      left: round1(crop.left),
      right: round1(crop.right),
      top: round1(crop.top),
      bottom: round1(crop.bottom),
      stretch: false,
    };
  }

  // Crop mode: compute the exact 1:3 sub-window inside the current crop box.
  const { src } = computeFitDrawRects({
    sourceWidth,
    sourceHeight,
    crop,
    target: { x: 0, y: 0, w: 100, h: 300 },
    mode: 'crop',
    offset,
  });
  const left = round1((src.x / sourceWidth) * 100);
  const right = round1(((sourceWidth - (src.x + src.w)) / sourceWidth) * 100);
  const top = round1((src.y / sourceHeight) * 100);
  const bottom = round1(
    ((sourceHeight - (src.y + src.h)) / sourceHeight) * 100,
  );
  if (left + right > 95 || top + bottom > 95) {
    return {
      left: round1(crop.left),
      right: round1(crop.right),
      top: round1(crop.top),
      bottom: round1(crop.bottom),
      stretch: false,
    };
  }
  return { left, right, top, bottom, stretch: false };
}

export function miniCoverFileName(
  title: string,
  resolution: MiniCoverResolution,
): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const dpiTag = resolutionConfig(resolution).dpiTag;
  return `${slug || 'book'}-mini-cover-50x30mm-${dpiTag}.png`;
}
