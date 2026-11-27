/**
 * Pure Canvas 2D renderer for printable 20 × 10 × 30 mm mini book covers.
 *
 * Renders into any CanvasRenderingContext2D at (0, 0) so both the interactive
 * studio preview and a future multi-cover print sheet page can share one
 * drawing routine.
 */

import {
  computeFitDrawRects,
  FULL_CROP_INSETS,
  type CropInsets,
  type MiniCoverBackStyle,
  type MiniCoverLayout,
  type MiniCoverSpineFit,
  type Rect,
} from '~/utils/miniCoverLayout';
import type { CardPalette } from '~/utils/shareCardPalette';

export type MiniCoverImageSource = {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Optional sampled edge color (hex) for letterbox padding in Fit mode. */
  edgeColor?: string | null;
};

export type MiniCoverRenderSources = {
  cover: MiniCoverImageSource | null;
  /** Null renders the plain type-only spine. */
  spine: MiniCoverImageSource | null;
  spineCrop?: CropInsets;
  spineFit: MiniCoverSpineFit;
  /** [-1, 1] crop pan offset along the overflowing axis. */
  spineOffset: number;
  backStyle: MiniCoverBackStyle;
  palette: CardPalette;
  book: {
    id: string;
    title: string;
    authors: string;
  };
};

export type MiniCoverRenderOptions = {
  foldMarks: boolean;
  trimMarks: boolean;
};

const FALLBACK_SPINE_COLORS = [
  '#425d49',
  '#a16855',
  '#a67d45',
  '#657b82',
  '#9b604c',
  '#6c765b',
  '#455d72',
  '#83715f',
];

export function hashedSpineColor(bookId: string): string {
  let hash = 0;
  for (const char of bookId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return FALLBACK_SPINE_COLORS[hash % FALLBACK_SPINE_COLORS.length]!;
}

/**
 * Samples the top and bottom rows of an image to compute an average edge color
 * for letterboxing in Fit mode. Returns null if sampling fails (e.g. tainted).
 */
export function sampleEdgeColor(img: HTMLImageElement): string | null {
  try {
    const w = 24;
    const h = 48;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (const y of [0, 1, h - 2, h - 1]) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3]! < 64) continue;
        r += data[i]!;
        g += data[i + 1]!;
        b += data[i + 2]!;
        count++;
      }
    }
    if (!count) return null;
    const hex = (n: number) =>
      Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, '0');
    return `#${hex(r / count)}${hex(g / count)}${hex(b / count)}`;
  } catch {
    return null;
  }
}

function drawCoverFill(
  ctx: CanvasRenderingContext2D,
  source: MiniCoverImageSource,
  target: Rect,
): void {
  const { src, dst } = computeFitDrawRects({
    sourceWidth: source.width,
    sourceHeight: source.height,
    target,
    mode: 'crop',
    offset: 0,
  });
  ctx.save();
  ctx.beginPath();
  ctx.rect(target.x, target.y, target.w, target.h);
  ctx.clip();
  ctx.drawImage(
    source.image,
    src.x,
    src.y,
    src.w,
    src.h,
    dst.x,
    dst.y,
    dst.w,
    dst.h,
  );
  ctx.restore();
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = words[0]!;
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]!}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      if (lines.length >= maxLines) return lines;
      current = words[i]!;
    }
  }
  if (lines.length < maxLines) lines.push(current);
  return lines;
}

function drawPlainCover(
  ctx: CanvasRenderingContext2D,
  bleedTarget: Rect,
  trimTarget: Rect,
  book: MiniCoverRenderSources['book'],
  palette: CardPalette,
  useSolidPalette: boolean,
): void {
  const bg = useSolidPalette ? palette.deep : hashedSpineColor(book.id);
  const ink = useSolidPalette ? palette.onDeep : '#ffffff';
  const muted = useSolidPalette
    ? palette.onDeepMuted
    : 'rgba(255, 255, 255, 0.78)';

  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(bleedTarget.x, bleedTarget.y, bleedTarget.w, bleedTarget.h);

  // Subtle decorative inset rule inside the finished cover area
  const pad = trimTarget.w * 0.1;
  ctx.strokeStyle = useSolidPalette
    ? palette.onDeepMuted
    : 'rgba(255, 255, 255, 0.22)';
  ctx.globalAlpha = useSolidPalette ? 0.3 : 1;
  ctx.lineWidth = Math.max(1, trimTarget.w * 0.008);
  ctx.strokeRect(
    trimTarget.x + pad,
    trimTarget.y + pad,
    trimTarget.w - pad * 2,
    trimTarget.h - pad * 2,
  );
  ctx.globalAlpha = 1;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (useSolidPalette) {
    // Clean back-cover style: compact title & author near the bottom
    const titleSize = Math.max(9, Math.round(trimTarget.w * 0.068));
    const authorSize = Math.max(7, Math.round(trimTarget.w * 0.05));
    const maxTextW = trimTarget.w - pad * 2.6;

    ctx.font = `600 ${titleSize}px Georgia, "PT Serif", serif`;
    ctx.fillStyle = ink;
    const titleLines = wrapTextLines(ctx, book.title, maxTextW, 3);
    const lineH = titleSize * 1.28;
    const authorGap = book.authors ? authorSize * 1.7 : 0;
    const bottomY = trimTarget.y + trimTarget.h - pad * 1.6;
    const startY = bottomY - authorGap - (titleLines.length - 1) * lineH;

    titleLines.forEach((line, idx) => {
      ctx.fillText(line, trimTarget.x + trimTarget.w / 2, startY + idx * lineH);
    });

    if (book.authors) {
      ctx.font = `400 ${authorSize}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = muted;
      const authorLine =
        wrapTextLines(ctx, book.authors, maxTextW, 1)[0] ?? book.authors;
      ctx.fillText(authorLine, trimTarget.x + trimTarget.w / 2, bottomY);
    }
  } else {
    // Plain front cover fallback when no cover image exists
    const titleSize = Math.max(11, Math.round(trimTarget.w * 0.095));
    const authorSize = Math.max(8, Math.round(trimTarget.w * 0.058));
    const maxTextW = trimTarget.w - pad * 2.5;

    ctx.font = `700 ${titleSize}px Georgia, "PT Serif", serif`;
    ctx.fillStyle = ink;
    const titleLines = wrapTextLines(ctx, book.title, maxTextW, 4);
    const lineH = titleSize * 1.25;
    const centerY = trimTarget.y + trimTarget.h * 0.44;
    const firstY = centerY - ((titleLines.length - 1) * lineH) / 2;
    titleLines.forEach((line, idx) => {
      ctx.fillText(line, trimTarget.x + trimTarget.w / 2, firstY + idx * lineH);
    });

    if (book.authors) {
      ctx.font = `400 ${authorSize}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = muted;
      const authorLine =
        wrapTextLines(ctx, book.authors, maxTextW, 1)[0] ?? book.authors;
      ctx.fillText(
        authorLine,
        trimTarget.x + trimTarget.w / 2,
        trimTarget.y + trimTarget.h - pad * 1.9,
      );
    }
  }
  ctx.restore();
}

function drawBlurredBack(
  ctx: CanvasRenderingContext2D,
  bleedTarget: Rect,
  trimTarget: Rect,
  cover: MiniCoverImageSource,
  palette: CardPalette,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(bleedTarget.x, bleedTarget.y, bleedTarget.w, bleedTarget.h);
  ctx.clip();

  ctx.fillStyle = palette.deep;
  ctx.fillRect(bleedTarget.x, bleedTarget.y, bleedTarget.w, bleedTarget.h);

  const blurPx = Math.max(4, Math.round(trimTarget.w * 0.045));
  // Expand slightly so blur edges do not reveal transparent borders
  const overscan = blurPx * 2;
  const expanded: Rect = {
    x: bleedTarget.x - overscan,
    y: bleedTarget.y - overscan,
    w: bleedTarget.w + overscan * 2,
    h: bleedTarget.h + overscan * 2,
  };
  ctx.filter = `blur(${blurPx}px)`;
  drawCoverFill(ctx, cover, expanded);
  ctx.filter = 'none';

  // Gentle scrim to soften detail so it reads cleanly as a back cover
  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.fillRect(bleedTarget.x, bleedTarget.y, bleedTarget.w, bleedTarget.h);
  ctx.restore();
}

function drawPlainSpine(
  ctx: CanvasRenderingContext2D,
  bleedSpine: Rect,
  trimSpine: Rect,
  book: MiniCoverRenderSources['book'],
): void {
  ctx.save();
  ctx.fillStyle = hashedSpineColor(book.id);
  ctx.fillRect(bleedSpine.x, bleedSpine.y, bleedSpine.w, bleedSpine.h);

  // Subtle vertical sheen matching Delb's shelf aesthetic
  const grad = ctx.createLinearGradient(
    trimSpine.x,
    0,
    trimSpine.x + trimSpine.w,
    0,
  );
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.14)');
  grad.addColorStop(0.2, 'rgba(255, 255, 255, 0)');
  grad.addColorStop(0.85, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
  ctx.fillStyle = grad;
  ctx.fillRect(bleedSpine.x, bleedSpine.y, bleedSpine.w, bleedSpine.h);

  // Rotate 90 degrees clockwise so title reads top-to-bottom like US book spines
  ctx.translate(trimSpine.x + trimSpine.w / 2, trimSpine.y + trimSpine.h / 2);
  ctx.rotate(Math.PI / 2);

  const availW = trimSpine.h * 0.84;
  const titleSize = Math.max(9, Math.round(trimSpine.w * 0.34));
  const authorSize = Math.max(7, Math.round(trimSpine.w * 0.22));
  ctx.textBaseline = 'middle';

  const truncate = (text: string, maxW: number) => {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) {
      t = t.slice(0, -1);
    }
    return `${t}…`;
  };

  if (book.authors) {
    ctx.font = `700 ${titleSize}px Georgia, "PT Serif", serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    const titleMaxW = availW * 0.66;
    ctx.fillText(truncate(book.title, titleMaxW), -availW / 2, 0);

    ctx.font = `400 ${authorSize}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.textAlign = 'right';
    const authorMaxW = availW * 0.3;
    ctx.fillText(truncate(book.authors, authorMaxW), availW / 2, 0);
  } else {
    ctx.font = `700 ${titleSize}px Georgia, "PT Serif", serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(truncate(book.title, availW), 0, 0);
  }
  ctx.restore();
}

function drawImageSpine(
  ctx: CanvasRenderingContext2D,
  bleedSpine: Rect,
  trimSpine: Rect,
  spine: MiniCoverImageSource,
  crop: CropInsets,
  fit: MiniCoverSpineFit,
  offset: number,
  palette: CardPalette,
): void {
  const fillBg = spine.edgeColor || palette.deep;

  ctx.save();
  ctx.beginPath();
  ctx.rect(bleedSpine.x, bleedSpine.y, bleedSpine.w, bleedSpine.h);
  ctx.clip();

  // Fill entire bleed + spine area with the edge color first
  ctx.fillStyle = fillBg;
  ctx.fillRect(bleedSpine.x, bleedSpine.y, bleedSpine.w, bleedSpine.h);

  const { src, dst } = computeFitDrawRects({
    sourceWidth: spine.width,
    sourceHeight: spine.height,
    crop,
    target: trimSpine,
    mode: fit,
    offset,
  });

  // Extend top and bottom 1-pixel strips into the vertical bleed when present
  if (bleedSpine.y < trimSpine.y && dst.y <= trimSpine.y + 1) {
    const bleedTopH = trimSpine.y - bleedSpine.y;
    ctx.drawImage(
      spine.image,
      src.x,
      src.y,
      src.w,
      Math.min(2, src.h),
      dst.x,
      bleedSpine.y,
      dst.w,
      bleedTopH + 1,
    );
  }
  const bleedBottomY = trimSpine.y + trimSpine.h;
  const bleedBottomEnd = bleedSpine.y + bleedSpine.h;
  if (bleedBottomEnd > bleedBottomY && dst.y + dst.h >= bleedBottomY - 1) {
    const bleedBottomH = bleedBottomEnd - bleedBottomY;
    ctx.drawImage(
      spine.image,
      src.x,
      Math.max(src.y, src.y + src.h - 2),
      src.w,
      Math.min(2, src.h),
      dst.x,
      bleedBottomY - 1,
      dst.w,
      bleedBottomH + 1,
    );
  }

  ctx.drawImage(
    spine.image,
    src.x,
    src.y,
    src.w,
    src.h,
    dst.x,
    dst.y,
    dst.w,
    dst.h,
  );
  ctx.restore();
}

function drawPrintMarks(
  ctx: CanvasRenderingContext2D,
  layout: MiniCoverLayout,
  options: MiniCoverRenderOptions,
): void {
  const { trimRect, artworkRect, folds, pxPerMm, bleedPx, marginPx } = layout;
  const lineWidth = Math.max(1, Math.round(pxPerMm * 0.12));

  const strokeHairline = (x1: number, y1: number, x2: number, y2: number) => {
    // Draw a crisp white halo + dark inner stroke so marks remain visible on any cover color
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = lineWidth * 2.4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(18, 18, 18, 0.9)';
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  };

  if (options.foldMarks) {
    const tickLen = Math.round(1.5 * pxPerMm);
    for (const fx of folds) {
      const x = Math.round(fx) + 0.5;
      if (marginPx > 0) {
        // Place fold ticks in the outer trim margin
        const gap = Math.max(2, Math.round(0.4 * pxPerMm));
        strokeHairline(x, 0, x, Math.max(2, artworkRect.y - gap));
        strokeHairline(
          x,
          Math.min(layout.height - 2, artworkRect.y + artworkRect.h + gap),
          x,
          layout.height,
        );
      } else if (bleedPx > 0) {
        // Keep fold ticks inside the bleed zone only so they are trimmed away
        const len = Math.min(tickLen, Math.max(2, bleedPx - 1));
        strokeHairline(x, artworkRect.y, x, artworkRect.y + len);
        strokeHairline(
          x,
          artworkRect.y + artworkRect.h - len,
          x,
          artworkRect.y + artworkRect.h,
        );
      } else {
        // No bleed: short 1.5 mm edge ticks at top and bottom of the fold lines
        strokeHairline(x, trimRect.y, x, trimRect.y + tickLen);
        strokeHairline(
          x,
          trimRect.y + trimRect.h - tickLen,
          x,
          trimRect.y + trimRect.h,
        );
      }
    }
  }

  if (options.trimMarks && marginPx > 0) {
    const gap = Math.max(2, Math.round(0.5 * pxPerMm));
    const tx0 = trimRect.x;
    const tx1 = trimRect.x + trimRect.w;
    const ty0 = trimRect.y;
    const ty1 = trimRect.y + trimRect.h;

    const corners: [number, number, number, number][] = [
      // [cornerX, cornerY, dirX, dirY]
      [tx0, ty0, -1, -1],
      [tx1, ty0, 1, -1],
      [tx0, ty1, -1, 1],
      [tx1, ty1, 1, 1],
    ];
    for (const [cx, cy, dx, dy] of corners) {
      // Horizontal mark into left/right margin
      const hxStart =
        dx < 0 ? artworkRect.x - gap : artworkRect.x + artworkRect.w + gap;
      const hxEnd = dx < 0 ? 0 : layout.width;
      strokeHairline(hxStart, cy + 0.5, hxEnd, cy + 0.5);

      // Vertical mark into top/bottom margin
      const vyStart =
        dy < 0 ? artworkRect.y - gap : artworkRect.y + artworkRect.h + gap;
      const vyEnd = dy < 0 ? 0 : layout.height;
      strokeHairline(cx + 0.5, vyStart, cx + 0.5, vyEnd);
    }
  }
}

export function renderMiniCover(
  ctx: CanvasRenderingContext2D,
  layout: MiniCoverLayout,
  sources: MiniCoverRenderSources,
  options: MiniCoverRenderOptions,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // White paper background for any trim-mark margin outside the artwork
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, layout.width, layout.height);

  const frontIsRight = layout.panels.front.x > layout.panels.spine.x;
  const frontBleed = frontIsRight
    ? layout.bleedPanels.right
    : layout.bleedPanels.left;
  const backBleed = frontIsRight
    ? layout.bleedPanels.left
    : layout.bleedPanels.right;

  // 1. Front cover panel
  if (sources.cover) {
    drawCoverFill(ctx, sources.cover, frontBleed);
  } else {
    drawPlainCover(
      ctx,
      frontBleed,
      layout.panels.front,
      sources.book,
      sources.palette,
      false,
    );
  }

  // 2. Back cover panel
  if (sources.backStyle === 'same') {
    if (sources.cover) {
      drawCoverFill(ctx, sources.cover, backBleed);
    } else {
      drawPlainCover(
        ctx,
        backBleed,
        layout.panels.back,
        sources.book,
        sources.palette,
        false,
      );
    }
  } else if (sources.backStyle === 'blur' && sources.cover) {
    drawBlurredBack(
      ctx,
      backBleed,
      layout.panels.back,
      sources.cover,
      sources.palette,
    );
  } else {
    drawPlainCover(
      ctx,
      backBleed,
      layout.panels.back,
      sources.book,
      sources.palette,
      true,
    );
  }

  // 3. Spine panel
  if (sources.spine) {
    drawImageSpine(
      ctx,
      layout.bleedPanels.spine,
      layout.panels.spine,
      sources.spine,
      sources.spineCrop ?? FULL_CROP_INSETS,
      sources.spineFit,
      sources.spineOffset,
      sources.palette,
    );
  } else {
    drawPlainSpine(
      ctx,
      layout.bleedPanels.spine,
      layout.panels.spine,
      sources.book,
    );
  }

  // 4. Optional print fold & trim marks
  if (options.foldMarks || options.trimMarks) {
    drawPrintMarks(ctx, layout, options);
  }

  ctx.restore();
}
