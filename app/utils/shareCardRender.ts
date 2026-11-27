/**
 * Canvas 2D renderer for finished-book share cards.
 *
 * `renderShareCard` draws one card into a context that is already sized to
 * the format (see `formatSize`). It only reads the model and options, so the
 * same call produces the live preview and the exported PNG. Fonts must be
 * loaded before the call; `SHARE_CARD_FONTS` lists the faces it uses.
 */

import {
  containRect,
  chartBars,
  coverRect,
  curvePoints,
  fitText,
  formatSize,
  insetRect,
  safeInsets,
  stackLayout,
  truncate,
  type MeasureText,
  type Rect,
  type StackItem,
} from './shareCardLayout';
import {
  formatCount,
  formatPace,
  shareCardStats,
  type ShareCardBackground,
  type ShareCardFormat,
  type ShareCardModel,
  type ShareCardPreset,
  type ShareCardStat,
} from './shareCardModel';
import type { CardPalette } from './shareCardPalette';

const SERIF = '"Noto Serif", Georgia, "Times New Roman", serif';
const SANS = 'Inter, "Helvetica Neue", Arial, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';

/** Font faces to load before rendering, as `document.fonts.load` arguments. */
export const SHARE_CARD_FONTS = [
  '500 40px "Noto Serif"',
  'italic 400 40px "Noto Serif"',
  '400 40px Inter',
  '600 40px Inter',
  '700 40px Inter',
  '500 40px "IBM Plex Mono"',
  '600 40px "IBM Plex Mono"',
];

export type ShareCardTheme = {
  bg: string;
  text: string;
  accent: string;
  muted: string;
};

export type ShareCardCover = {
  image: CanvasImageSource;
  width: number;
  height: number;
};

export type ShareCardRenderOptions = {
  preset: ShareCardPreset;
  format: ShareCardFormat;
  background: ShareCardBackground;
  palette: CardPalette;
  theme: ShareCardTheme;
  cover: ShareCardCover | null;
};

type Ctx = CanvasRenderingContext2D;

// Delb mark paths from app/components/DelbLogo.vue (viewBox 0 0 250 250).
const MARK_PATHS = [
  'M402.741,681.096C402.741,677.759 404.082,674.558 406.467,672.201C408.853,669.843 412.087,668.523 415.457,668.531C436.259,668.547 476.674,668.636 490.909,669.071C500.579,669.366 517.485,671.727 519.774,672.105C557.715,678.369 584.245,705.266 594.111,737.962C603.725,769.821 596.814,806.329 571.82,831.893C562.785,841.135 551.143,849.365 536.5,855.045C532.006,856.788 527.231,858.291 522.161,859.51C521.574,859.648 520.973,859.348 520.737,858.798C520.502,858.249 520.701,857.612 521.208,857.29C523.668,855.729 526.01,854.083 528.237,852.37C531.04,850.214 533.684,847.919 536.168,845.502C536.527,845.151 536.948,844.867 537.409,844.662C538.09,844.359 538.764,844.051 539.431,843.736C549.816,838.837 558.352,832.49 565.232,825.452C587.799,802.37 593.971,769.39 585.29,740.623C576.392,711.135 552.492,686.845 518.273,681.195C516.059,680.83 506.843,679.274 490.347,678.267C489.75,678.23 462.73,677.361 443.365,676.74C442.673,676.714 442.08,677.222 442.004,677.903C441.929,678.585 442.398,679.208 443.078,679.331C457.279,681.726 474.323,684.608 474.952,684.751C490.206,688.208 498.581,691.102 500.594,691.788C533.977,703.156 554.131,732.068 558.413,763.945C562.586,795.008 551.174,827.986 524.98,848.137C504.934,863.559 474.984,873.054 433.792,862.499C433.792,862.499 421.38,859.318 412.251,856.979C406.653,855.545 402.742,850.542 402.742,844.814C402.742,813.604 402.741,716 402.741,681.096ZM448.614,721.429C447.441,721.335 446.281,721.731 445.416,722.521C444.551,723.312 444.059,724.424 444.059,725.59C444.045,743.211 444.045,804.319 444.045,819.202C444.045,821.155 445.407,822.849 447.33,823.285C527.896,841.383 537.13,747.862 487.28,730.885C485.595,730.312 478.581,727.923 465.823,725.031C464.532,724.739 454.776,722.528 448.614,721.429Z',
  'M556.153,820.95C555.877,821.49 556.034,822.148 556.526,822.507C557.017,822.866 557.698,822.821 558.137,822.4C558.816,821.76 559.475,821.109 560.118,820.452C580.801,799.296 586.399,769.055 578.442,742.69C570.295,715.692 548.438,693.426 517.108,688.253C516.952,688.227 516.759,688.195 516.531,688.158C515.918,688.058 515.323,688.417 515.132,689.002C514.94,689.588 515.209,690.224 515.765,690.5C544.202,705.168 561.451,732.83 565.502,762.993C568.147,782.68 564.961,803.07 556.153,820.95Z',
];
let markPaths: Path2D[] | null = null;

function font(
  weight: number,
  size: number,
  family: string,
  italic = false,
): string {
  return `${italic ? 'italic ' : ''}${weight} ${Math.round(size * 10) / 10}px ${family}`;
}

function measurer(ctx: Ctx): MeasureText {
  return (text, f) => {
    ctx.font = f;
    return ctx.measureText(text).width;
  };
}

/** Width of text drawn with extra space between letters. */
function trackedWidth(ctx: Ctx, text: string, f: string, spacing: number) {
  ctx.font = f;
  if (!spacing) return ctx.measureText(text).width;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width;
  return w + spacing * Math.max(0, [...text].length - 1);
}

/** Draws text with letter spacing. Canvas letterSpacing is not universal. */
function drawTracked(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  f: string,
  spacing: number,
  align: 'left' | 'center' | 'right' = 'left',
) {
  const width = trackedWidth(ctx, text, f, spacing);
  let cx =
    align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  ctx.font = f;
  ctx.textAlign = 'left';
  if (!spacing) {
    ctx.fillText(text, cx, y);
    return width;
  }
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
  return width;
}

function roundRectPath(ctx: Ctx, r: Rect, radius: number) {
  const rad = Math.max(0, Math.min(radius, r.width / 2, r.height / 2));
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.width, r.y, r.x + r.width, r.y + r.height, rad);
  ctx.arcTo(r.x + r.width, r.y + r.height, r.x, r.y + r.height, rad);
  ctx.arcTo(r.x, r.y + r.height, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.width, r.y, rad);
  ctx.closePath();
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1] as string, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function coverAspect(cover: ShareCardCover | null): number {
  if (!cover || !cover.width || !cover.height) return 2 / 3;
  return Math.min(1, Math.max(0.5, cover.width / cover.height));
}

type Shadow = { color: string; blur: number; y: number } | null;

function applyShadow(ctx: Ctx, shadow: Shadow) {
  if (!shadow) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    return;
  }
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = shadow.y;
}

function drawMark(ctx: Ctx, x: number, y: number, size: number, color: string) {
  if (typeof Path2D === 'undefined') return;
  markPaths ??= MARK_PATHS.map((d) => new Path2D(d));
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 250, size / 250);
  ctx.transform(1.166, 0, 0, 1.17721, -36.3688, 18.2309);
  ctx.transform(1.01405, 0, 0, 1.01405, -369.144, -687.842);
  ctx.fillStyle = color;
  for (const p of markPaths) ctx.fill(p);
  ctx.restore();
}

/** Draws the mark and the "delb" wordmark; returns the lockup width. */
function drawLockup(
  ctx: Ctx,
  x: number,
  y: number,
  size: number,
  markColor: string,
  textColor: string,
  align: 'left' | 'right' | 'center' = 'left',
) {
  const f = font(650, size * 0.78, SANS);
  ctx.font = f;
  const textW = ctx.measureText('delb').width;
  const gap = size * 0.22;
  const width = size + gap + textW;
  const left =
    align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
  drawMark(ctx, left, y, size, markColor);
  ctx.fillStyle = textColor;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('delb', left + size + gap, y + size * 0.52);
  ctx.textBaseline = 'alphabetic';
  return width;
}

function starPath(ctx: Ctx, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? r : r * 0.45;
    const px = cx + Math.cos(angle) * radius;
    const py = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Draws one filled star in a size × size box. */
function drawStar(ctx: Ctx, x: number, y: number, size: number, color: string) {
  starPath(ctx, x + size / 2, y + size / 2 + size * 0.04, size / 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Draws five stars with half-star fill; returns the row width. */
function drawStars(
  ctx: Ctx,
  x: number,
  y: number,
  size: number,
  stars: number,
  color: string,
  emptyAlpha = 0.25,
  align: 'left' | 'center' | 'right' = 'left',
) {
  const gap = size * 0.22;
  const width = size * 5 + gap * 4;
  const left =
    align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  for (let i = 0; i < 5; i++) {
    const cx = left + i * (size + gap) + size / 2;
    const cy = y + size / 2;
    const fill = Math.max(0, Math.min(1, stars - i));
    ctx.save();
    starPath(ctx, cx, cy + size * 0.04, size / 2);
    ctx.globalAlpha *= emptyAlpha;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    if (fill > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - size / 2, cy - size / 2, size * fill, size);
      ctx.clip();
      starPath(ctx, cx, cy + size * 0.04, size / 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }
  }
  return width;
}

function drawCover(
  ctx: Ctx,
  opts: ShareCardRenderOptions,
  model: ShareCardModel,
  rect: Rect,
  style: {
    radius: number;
    shadow?: Shadow;
    hardShadow?: { dx: number; dy: number; color: string };
  },
) {
  if (style.hardShadow) {
    ctx.save();
    ctx.fillStyle = style.hardShadow.color;
    roundRectPath(
      ctx,
      {
        ...rect,
        x: rect.x + style.hardShadow.dx,
        y: rect.y + style.hardShadow.dy,
      },
      style.radius,
    );
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  if (style.shadow) {
    applyShadow(ctx, style.shadow);
    ctx.fillStyle = opts.palette.deeper;
    roundRectPath(ctx, rect, style.radius);
    ctx.fill();
    applyShadow(ctx, null);
  }
  roundRectPath(ctx, rect, style.radius);
  ctx.clip();
  if (opts.cover) {
    ctx.drawImage(opts.cover.image, rect.x, rect.y, rect.width, rect.height);
  } else {
    drawPlaceholderCover(ctx, opts.palette, model, rect);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = Math.max(1, rect.width / 240);
  roundRectPath(ctx, rect, style.radius);
  ctx.stroke();
  ctx.restore();
}

function drawPlaceholderCover(
  ctx: Ctx,
  palette: CardPalette,
  model: ShareCardModel,
  rect: Rect,
) {
  const g = ctx.createLinearGradient(
    rect.x,
    rect.y,
    rect.x + rect.width * 0.3,
    rect.y + rect.height,
  );
  g.addColorStop(0, palette.glow);
  g.addColorStop(1, palette.deeper);
  ctx.fillStyle = g;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  const pad = rect.width * 0.12;
  const measure = measurer(ctx);
  const fitted = fitText(
    model.title,
    rect.width - pad * 2,
    (s) => font(500, s, SERIF),
    measure,
    { maxSize: rect.width * 0.14, minSize: rect.width * 0.07, maxLines: 4 },
  );
  ctx.fillStyle = palette.onDeep;
  ctx.textAlign = 'center';
  ctx.font = font(500, fitted.size, SERIF);
  fitted.lines.forEach((line, i) => {
    ctx.fillText(
      line,
      rect.x + rect.width / 2,
      rect.y + rect.height * 0.28 + i * fitted.size * 1.2,
    );
  });
  if (model.authors) {
    const af = font(600, rect.width * 0.055, SANS);
    ctx.fillStyle = palette.onDeepMuted;
    drawTracked(
      ctx,
      truncate(model.authors.toUpperCase(), rect.width - pad * 2, af, measure),
      rect.x + rect.width / 2,
      rect.y + rect.height * 0.9,
      af,
      rect.width * 0.008,
      'center',
    );
  }
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(rect.x, rect.y, rect.width * 0.05, rect.height);
}

function scratchCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(width, height);
    return {
      canvas: c,
      ctx: c.getContext('2d') as OffscreenCanvasRenderingContext2D | null,
    };
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return { canvas: c, ctx: c.getContext('2d') };
  }
  return null;
}

/**
 * Fills the card with a soft, darkened copy of the cover. The blur comes from
 * drawing the cover very small and scaling it back up, which works in every
 * browser, unlike the canvas `filter` property.
 */
function drawSoftCover(
  ctx: Ctx,
  opts: ShareCardRenderOptions,
  W: number,
  H: number,
) {
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, opts.palette.glow);
  base.addColorStop(1, opts.palette.deeper);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  if (opts.cover) {
    const tinyW = 18;
    const tinyH = Math.max(1, Math.round((tinyW * H) / W));
    const tiny = scratchCanvas(tinyW, tinyH);
    const mid = scratchCanvas(tinyW * 4, tinyH * 4);
    if (tiny?.ctx && mid?.ctx) {
      const r = coverRect(coverAspect(opts.cover), {
        x: 0,
        y: 0,
        width: tinyW,
        height: tinyH,
      });
      tiny.ctx.imageSmoothingQuality = 'high';
      tiny.ctx.drawImage(opts.cover.image, r.x, r.y, r.width, r.height);
      mid.ctx.imageSmoothingQuality = 'high';
      mid.ctx.drawImage(tiny.canvas, 0, 0, tinyW * 4, tinyH * 4);
      ctx.save();
      ctx.imageSmoothingQuality = 'high';
      // Overscan hides the soft, lighter edge of the scaled image.
      ctx.drawImage(mid.canvas, -W * 0.06, -H * 0.06, W * 1.12, H * 1.12);
      ctx.restore();
    }
  }
  ctx.fillStyle = 'rgba(8, 8, 10, 0.42)';
  ctx.fillRect(0, 0, W, H);
  const v = ctx.createRadialGradient(
    W / 2,
    H * 0.45,
    Math.min(W, H) * 0.3,
    W / 2,
    H * 0.45,
    Math.max(W, H) * 0.75,
  );
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function unitFor(format: ShareCardFormat, W: number) {
  return format === 'landscape' ? 7.4 : W / 100;
}

function hairline(
  ctx: Ctx,
  x1: number,
  y: number,
  x2: number,
  color: string,
  width = 1.5,
) {
  ctx.fillStyle = color;
  ctx.fillRect(x1, Math.round(y), x2 - x1, width);
}

// ---------------------------------------------------------------------------
// 1 · Cover palette
// ---------------------------------------------------------------------------

function renderCoverPalette(
  ctx: Ctx,
  model: ShareCardModel,
  opts: ShareCardRenderOptions,
) {
  const { width: W, height: H } = formatSize(opts.format);
  const u = unitFor(opts.format, W);
  const p = opts.palette;
  const measure = measurer(ctx);

  ctx.fillStyle = p.deeper;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(
    W / 2,
    H * 0.36,
    0,
    W / 2,
    H * 0.36,
    Math.max(W, H) * 0.78,
  );
  g.addColorStop(0, p.glow);
  g.addColorStop(0.55, p.deep);
  g.addColorStop(1, p.deeper);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const warm = ctx.createRadialGradient(
    W / 2,
    H * 1.05,
    0,
    W / 2,
    H * 1.05,
    W * 0.62,
  );
  warm.addColorStop(0, withAlpha(p.accent, 0.26));
  warm.addColorStop(1, withAlpha(p.accent, 0));
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, W, H);

  const area = insetRect({ width: W, height: H }, safeInsets(opts.format));
  const markSize = 4.6 * u;
  const stats = shareCardStats(model).filter((s) => s.key !== 'rating');
  const caption = [model.dateRange, model.yearOrdinal]
    .filter(Boolean)
    .join(' · ');

  if (opts.format === 'landscape') {
    const coverBox = containRect(coverAspect(opts.cover), {
      x: area.x,
      y: area.y,
      width: area.width * 0.34,
      height: area.height,
    });
    drawCover(ctx, opts, model, coverBox, {
      radius: 0.8 * u,
      shadow: { color: 'rgba(0,0,0,0.55)', blur: 5 * u, y: 2.4 * u },
    });
    const x = coverBox.x + coverBox.width + 7 * u;
    const textArea = {
      x,
      y: area.y,
      width: area.x + area.width - x,
      height: area.height,
    };
    drawCoverPaletteText(
      ctx,
      model,
      opts,
      textArea,
      u,
      stats,
      caption,
      'left',
      measure,
      markSize,
    );
    return;
  }

  const bottomReserve = model.showLogo ? markSize + 4 * u : 0;
  const content = { ...area, height: area.height - bottomReserve };
  const titleFit = fitText(
    model.title,
    content.width,
    (s) => font(500, s, SERIF),
    measure,
    {
      maxSize: 5.6 * u,
      minSize: 3.8 * u,
      maxLines: 2,
    },
  );
  const items: StackItem[] = [
    { height: 2.2 * u },
    {
      height: 0,
      gap: 5 * u,
      flex: { min: 22 * u, max: opts.format === 'story' ? 78 * u : 40 * u },
    },
    { height: titleFit.lines.length * titleFit.size * 1.18, gap: 5.5 * u },
    { height: model.authors ? 3 * u : 0, gap: model.authors ? 1.4 * u : 0 },
    {
      height: model.stars != null ? 3.4 * u : 0,
      gap: model.stars != null ? 3.2 * u : 0,
    },
    { height: stats.length ? 7.6 * u : 0, gap: stats.length ? 4.6 * u : 0 },
    { height: caption ? 2 * u : 0, gap: caption ? 3.4 * u : 0 },
  ];
  const pos = stackLayout(items, content);
  const cx = W / 2;
  ctx.textAlign = 'center';

  ctx.fillStyle = withAlpha(p.onDeep, 0.62);
  drawTracked(
    ctx,
    model.eyebrow.toUpperCase(),
    cx,
    pos[0]!.y + 2 * u,
    font(600, 2.2 * u, SANS),
    0.6 * u,
    'center',
  );

  const coverBox = containRect(coverAspect(opts.cover), {
    x: content.x + content.width * 0.18,
    y: pos[1]!.y,
    width: content.width * 0.64,
    height: pos[1]!.height,
  });
  drawCover(ctx, opts, model, coverBox, {
    radius: 0.8 * u,
    shadow: { color: 'rgba(0,0,0,0.55)', blur: 5 * u, y: 2.4 * u },
  });

  ctx.fillStyle = p.onDeep;
  ctx.font = font(500, titleFit.size, SERIF);
  ctx.textAlign = 'center';
  titleFit.lines.forEach((line, i) => {
    ctx.fillText(line, cx, pos[2]!.y + titleFit.size * (0.92 + i * 1.18));
  });
  if (model.authors) {
    const af = font(400, 3 * u, SERIF, true);
    ctx.font = af;
    ctx.fillStyle = withAlpha(p.onDeep, 0.7);
    ctx.fillText(
      truncate(model.authors, content.width, af, measure),
      cx,
      pos[3]!.y + 2.5 * u,
    );
  }
  if (model.stars != null) {
    drawStars(
      ctx,
      cx,
      pos[4]!.y,
      3.4 * u,
      model.stars,
      p.accent,
      0.28,
      'center',
    );
  }
  if (stats.length) {
    drawCenteredStats(
      ctx,
      stats,
      cx,
      pos[5]!.y,
      u,
      p.onDeep,
      withAlpha(p.onDeep, 0.25),
    );
  }
  if (caption) {
    const cf = font(500, 2 * u, SANS);
    ctx.fillStyle = withAlpha(p.onDeep, 0.55);
    ctx.font = cf;
    ctx.textAlign = 'center';
    ctx.fillText(
      truncate(caption, content.width, cf, measure),
      cx,
      pos[6]!.y + 1.7 * u,
    );
  }
  if (model.showLogo) {
    drawMark(
      ctx,
      cx - markSize / 2,
      area.y + area.height - markSize,
      markSize,
      p.accent,
    );
  }
}

function drawCenteredStats(
  ctx: Ctx,
  stats: ShareCardStat[],
  cx: number,
  y: number,
  u: number,
  color: string,
  ruleColor: string,
) {
  const numFont = font(500, 4.6 * u, SERIF);
  const labelFont = font(600, 1.9 * u, SANS);
  const spacing = 0.4 * u;
  const widths = stats.map((s) =>
    Math.max(
      trackedWidth(ctx, s.value, numFont, 0),
      trackedWidth(ctx, s.label.toUpperCase(), labelFont, spacing),
    ),
  );
  const gap = 8 * u;
  const total = widths.reduce((a, b) => a + b, 0) + gap * (stats.length - 1);
  let x = cx - total / 2;
  stats.forEach((s, i) => {
    const w = widths[i] as number;
    const mid = x + w / 2;
    ctx.fillStyle = color;
    ctx.font = numFont;
    ctx.textAlign = 'center';
    ctx.fillText(s.value, mid, y + 4 * u);
    ctx.fillStyle = withAlpha(color, 0.55);
    drawTracked(
      ctx,
      s.label.toUpperCase(),
      mid,
      y + 7.2 * u,
      labelFont,
      spacing,
      'center',
    );
    if (i < stats.length - 1) {
      ctx.fillStyle = ruleColor;
      ctx.fillRect(x + w + gap / 2, y + 0.6 * u, 1.5, 6.4 * u);
    }
    x += w + gap;
  });
}

function drawCoverPaletteText(
  ctx: Ctx,
  model: ShareCardModel,
  opts: ShareCardRenderOptions,
  area: Rect,
  u: number,
  stats: ShareCardStat[],
  caption: string,
  _align: 'left',
  measure: MeasureText,
  markSize: number,
) {
  const p = opts.palette;
  const titleFit = fitText(
    model.title,
    area.width,
    (s) => font(500, s, SERIF),
    measure,
    {
      maxSize: 7.5 * u,
      minSize: 4.6 * u,
      maxLines: 3,
    },
  );
  const items: StackItem[] = [
    { height: 2.6 * u },
    { height: titleFit.lines.length * titleFit.size * 1.16, gap: 4 * u },
    { height: model.authors ? 3.8 * u : 0, gap: model.authors ? 1.8 * u : 0 },
    {
      height: model.stars != null ? 4 * u : 0,
      gap: model.stars != null ? 4 * u : 0,
    },
    { height: stats.length ? 9.5 * u : 0, gap: stats.length ? 6 * u : 0 },
    { height: caption ? 2.6 * u : 0, gap: caption ? 4 * u : 0 },
  ];
  const pos = stackLayout(items, { y: area.y, height: area.height });
  ctx.textAlign = 'left';
  ctx.fillStyle = withAlpha(p.onDeep, 0.62);
  drawTracked(
    ctx,
    model.eyebrow.toUpperCase(),
    area.x,
    pos[0]!.y + 2.4 * u,
    font(600, 2.6 * u, SANS),
    0.7 * u,
  );
  ctx.fillStyle = p.onDeep;
  ctx.font = font(500, titleFit.size, SERIF);
  titleFit.lines.forEach((line, i) =>
    ctx.fillText(line, area.x, pos[1]!.y + titleFit.size * (0.92 + i * 1.16)),
  );
  if (model.authors) {
    const af = font(400, 3.8 * u, SERIF, true);
    ctx.font = af;
    ctx.fillStyle = withAlpha(p.onDeep, 0.7);
    ctx.fillText(
      truncate(model.authors, area.width, af, measure),
      area.x,
      pos[2]!.y + 3.1 * u,
    );
  }
  if (model.stars != null)
    drawStars(ctx, area.x, pos[3]!.y, 4 * u, model.stars, p.accent, 0.28);
  if (stats.length) {
    let x = area.x;
    const numFont = font(500, 6.2 * u, SERIF);
    const labelFont = font(600, 2.3 * u, SANS);
    stats.forEach((s) => {
      ctx.fillStyle = p.onDeep;
      ctx.font = numFont;
      ctx.fillText(s.value, x, pos[4]!.y + 5.6 * u);
      ctx.fillStyle = withAlpha(p.onDeep, 0.55);
      const lw = drawTracked(
        ctx,
        s.label.toUpperCase(),
        x,
        pos[4]!.y + 9.2 * u,
        labelFont,
        0.5 * u,
      );
      ctx.font = numFont;
      x += Math.max(ctx.measureText(s.value).width, lw) + 8 * u;
    });
  }
  if (caption) {
    const cf = font(500, 2.6 * u, SANS);
    ctx.font = cf;
    ctx.fillStyle = withAlpha(p.onDeep, 0.55);
    ctx.fillText(
      truncate(caption, area.width, cf, measure),
      area.x,
      pos[5]!.y + 2.2 * u,
    );
  }
  if (model.showLogo) {
    const { width: W, height: H } = formatSize(opts.format);
    drawMark(
      ctx,
      W - safeInsets(opts.format).right - markSize,
      H - safeInsets(opts.format).bottom - markSize,
      markSize,
      p.accent,
    );
  }
}

// ---------------------------------------------------------------------------
// 2 · Editorial split
// ---------------------------------------------------------------------------

function renderEditorialSplit(
  ctx: Ctx,
  model: ShareCardModel,
  opts: ShareCardRenderOptions,
) {
  const { width: W, height: H } = formatSize(opts.format);
  const u = unitFor(opts.format, W);
  const p = opts.palette;
  const measure = measurer(ctx);
  const insets = safeInsets(opts.format);
  const story = opts.format === 'story';

  const panel: Rect = story
    ? { x: 0, y: 0, width: W, height: H * 0.52 }
    : {
        x: 0,
        y: 0,
        width: W * (opts.format === 'landscape' ? 0.36 : 0.44),
        height: H,
      };
  const content: Rect = story
    ? {
        x: insets.left,
        y: panel.height + 7 * u,
        width: W - insets.left - insets.right,
        height: H - panel.height - 7 * u - insets.bottom,
      }
    : {
        x: panel.width + 6.5 * u,
        y: insets.top * 0.8,
        width: W - panel.width - 6.5 * u - insets.right * 0.8,
        height: H - insets.top * 0.8 - insets.bottom * 0.8,
      };

  // Paper side
  const paper = ctx.createLinearGradient(0, 0, W * 0.4, H);
  paper.addColorStop(0, p.paper);
  paper.addColorStop(1, p.mat);
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);

  // Cover panel
  const pg = ctx.createLinearGradient(
    panel.x,
    panel.y,
    panel.x + panel.width * 0.35,
    panel.y + panel.height,
  );
  pg.addColorStop(0, p.glow);
  pg.addColorStop(1, p.deeper);
  ctx.fillStyle = pg;
  ctx.fillRect(panel.x, panel.y, panel.width, panel.height);
  const glow = ctx.createRadialGradient(
    panel.x + panel.width * 0.3,
    panel.y + panel.height * 0.2,
    0,
    panel.x + panel.width * 0.3,
    panel.y + panel.height * 0.2,
    Math.max(panel.width, panel.height) * 0.7,
  );
  glow.addColorStop(0, withAlpha(p.accent, 0.28));
  glow.addColorStop(1, withAlpha(p.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(panel.x, panel.y, panel.width, panel.height);

  const coverArea: Rect = story
    ? {
        x: panel.width * 0.2,
        y: insets.top,
        width: panel.width * 0.6,
        height: panel.height - insets.top - 9 * u,
      }
    : {
        x: panel.width * 0.16,
        y: panel.height * 0.16,
        width: panel.width * 0.68,
        height: panel.height * 0.68,
      };
  drawCover(ctx, opts, model, containRect(coverAspect(opts.cover), coverArea), {
    radius: 0.8 * u,
    shadow: { color: 'rgba(0,0,0,0.55)', blur: 5 * u, y: 2.6 * u },
  });
  if (model.monthLabel) {
    ctx.fillStyle = withAlpha(p.onDeep, 0.62);
    drawTracked(
      ctx,
      model.monthLabel.toUpperCase(),
      story ? insets.left : panel.x + 6 * u,
      panel.y + panel.height - (story ? 4 * u : 6 * u),
      font(600, 1.9 * u, SANS),
      0.45 * u,
    );
  }

  // Lockup
  let titleTop = content.y + (story ? 0 : 9 * u);
  if (model.showLogo) {
    const size = 3.6 * u;
    if (story) {
      drawLockup(
        ctx,
        W - insets.right,
        panel.height - 4 * u - size * 0.8,
        size,
        p.onDeep,
        p.onDeep,
        'right',
      );
    } else {
      drawLockup(
        ctx,
        content.x + content.width,
        content.y,
        size,
        p.accent,
        p.ink,
        'right',
      );
    }
  } else if (!story) {
    titleTop = content.y + 4 * u;
  }

  // Title & author
  const titleFit = fitText(
    model.title,
    content.width,
    (s) => font(500, s, SERIF),
    measure,
    {
      maxSize: (story ? 6 : 4.6) * u,
      minSize: 3.2 * u,
      maxLines: 3,
    },
  );
  ctx.textAlign = 'left';
  ctx.fillStyle = p.ink;
  ctx.font = font(500, titleFit.size, SERIF);
  titleFit.lines.forEach((line, i) =>
    ctx.fillText(line, content.x, titleTop + titleFit.size * (0.92 + i * 1.14)),
  );
  let y = titleTop + titleFit.lines.length * titleFit.size * 1.14;
  if (model.authors) {
    const af = font(400, 2.7 * u, SERIF, true);
    ctx.font = af;
    ctx.fillStyle = p.inkMuted;
    ctx.fillText(
      truncate(model.authors, content.width, af, measure),
      content.x,
      y + 3.4 * u,
    );
    y += 4.2 * u;
  }
  if (model.stars != null) {
    drawStars(ctx, content.x, y + 2.2 * u, 2.8 * u, model.stars, p.ink, 0.22);
    y += 5 * u;
  }

  // Bottom block: hero, caption, pace row
  const bottom = content.y + content.height;
  let cursor = bottom;
  const paceText =
    model.pagesPerDay != null
      ? `${formatPace(model.pagesPerDay)} pages a day`
      : null;
  const best =
    model.chart && model.chart.unit === 'pages' && model.chart.bestDay > 0
      ? `best day: ${formatCount(model.chart.bestDay)}`
      : null;
  if (model.chart || paceText) {
    const rowH = 7.5 * u;
    const rowTop = cursor - rowH;
    hairline(
      ctx,
      content.x,
      rowTop - 3.5 * u,
      content.x + content.width,
      withAlpha(p.ink, 0.18),
    );
    let tx = content.x;
    if (model.chart) {
      const chartW = Math.min(content.width * 0.36, (story ? 34 : 15) * u);
      const bars = chartBars(
        model.chart.points,
        { x: content.x, y: rowTop, width: chartW, height: rowH },
        { maxBars: 14 },
      );
      for (const b of bars) {
        ctx.fillStyle = withAlpha(p.ink, b.best ? 0.95 : 0.5);
        roundRectPath(ctx, b, Math.min(b.width / 4, 0.25 * u));
        ctx.fill();
      }
      tx += chartW + 2.6 * u;
    }
    const lead =
      paceText ?? `${model.chart?.startLabel} – ${model.chart?.endLabel}`;
    ctx.fillStyle = p.ink;
    const lf = font(650, (story ? 3.3 : 2.8) * u, SANS);
    ctx.font = lf;
    ctx.fillText(
      truncate(lead, content.x + content.width - tx, lf, measure),
      tx,
      rowTop + rowH - (best ? 3.2 * u : 1 * u),
    );
    if (best) {
      ctx.fillStyle = p.inkMuted;
      const bf = font(500, 2.2 * u, MONO);
      ctx.font = bf;
      ctx.fillText(best, tx, rowTop + rowH);
    }
    cursor = rowTop - 7.5 * u;
  }

  const hero =
    model.progressPercent != null
      ? {
          value: String(Math.round(model.progressPercent)),
          unit: '%',
        }
      : model.durationDays != null
        ? {
            value: formatCount(model.durationDays),
            unit: model.durationDays === 1 ? 'day' : 'days',
          }
        : model.pages != null
          ? { value: formatCount(model.pages), unit: 'pages' }
          : null;
  if (hero) {
    const parts: string[] = [];
    if (model.progressPercent != null) {
      parts.push(model.status === 'dnf' ? 'Progress reached' : 'Progress');
      if (model.durationDays != null)
        parts.push(
          `${formatCount(model.durationDays)} ${model.durationDays === 1 ? 'day' : 'days'}`,
        );
      if (model.pages != null) parts.push(`${formatCount(model.pages)} pages`);
    } else {
      if (model.durationDays != null) parts.push(model.durationCaption);
      if (model.durationDays != null && model.pages != null)
        parts.push(`${formatCount(model.pages)} pages`);
      if (model.durationDays == null && model.dateRange)
        parts.push(model.dateRange);
    }
    if (model.yearOrdinal) parts.push(model.yearOrdinal);
    const cap = parts.join(' · ').toUpperCase();
    if (cap) {
      ctx.fillStyle = p.inkMuted;
      const cf = font(600, 1.9 * u, SANS);
      drawTracked(
        ctx,
        truncate(cap, content.width, cf, measure),
        content.x,
        cursor,
        cf,
        0.35 * u,
      );
      cursor -= 4.2 * u;
    }
    const unitFont = font(500, 4.6 * u, SERIF);
    const unitW = measure(hero.unit, unitFont);
    const maxHero = Math.min((story ? 30 : 22) * u, cursor - y - 4 * u);
    let size = Math.max(6 * u, maxHero);
    while (
      size > 6 * u &&
      measure(hero.value, font(500, size, SERIF)) + unitW + 1.6 * u >
        content.width
    )
      size -= u;
    ctx.fillStyle = p.ink;
    ctx.font = font(500, size, SERIF);
    ctx.fillText(hero.value, content.x - size * 0.04, cursor);
    const hw = ctx.measureText(hero.value).width;
    ctx.font = unitFont;
    ctx.fillText(hero.unit, content.x + hw + 1.4 * u, cursor);
  } else if (model.dateRange || model.yearOrdinal) {
    ctx.fillStyle = p.inkMuted;
    const cf = font(600, 2.2 * u, SANS);
    drawTracked(
      ctx,
      [model.dateRange, model.yearOrdinal]
        .filter(Boolean)
        .join(' · ')
        .toUpperCase(),
      content.x,
      cursor,
      cf,
      0.35 * u,
    );
  }
}

// ---------------------------------------------------------------------------
// 3 · Swiss grid
// ---------------------------------------------------------------------------

function renderSwissGrid(
  ctx: Ctx,
  model: ShareCardModel,
  opts: ShareCardRenderOptions,
) {
  const { width: W, height: H } = formatSize(opts.format);
  const u = unitFor(opts.format, W);
  const p = opts.palette;
  const measure = measurer(ctx);
  const story = opts.format === 'story';
  const landscape = opts.format === 'landscape';
  const insets = safeInsets(opts.format);
  const area = story
    ? insetRect(
        { width: W, height: H },
        { ...insets, left: 7 * u, right: 7 * u },
      )
    : insetRect(
        { width: W, height: H },
        landscape
          ? insets
          : { top: 7 * u, right: 7 * u, bottom: 7 * u, left: 7 * u },
      );
  const rule = withAlpha(p.ink, 0.34);

  ctx.fillStyle = p.paper;
  ctx.fillRect(0, 0, W, H);

  // Header
  const headerH = 8 * u;
  ctx.fillStyle = p.ink;
  drawTracked(
    ctx,
    model.statusBanner,
    area.x,
    area.y + headerH - 2.2 * u,
    font(600, 2.6 * u, MONO),
    0.26 * u,
  );
  if (model.showLogo) {
    const ms = 6 * u;
    drawMark(
      ctx,
      area.x + area.width - ms,
      area.y + headerH - 1.6 * u - ms,
      ms,
      p.ink,
    );
  } else if (model.monthLabel) {
    ctx.fillStyle = p.inkMuted;
    drawTracked(
      ctx,
      model.monthLabel.toUpperCase(),
      area.x + area.width,
      area.y + headerH - 2.2 * u,
      font(600, 2.6 * u, MONO),
      0.26 * u,
      'right',
    );
  }
  hairline(ctx, area.x, area.y + headerH, area.x + area.width, rule);

  const stats = shareCardStats(model);
  const statsH = stats.length ? 11 * u : 0;
  const footnote = [model.dateRange, model.yearOrdinal]
    .filter(Boolean)
    .join(' · ');
  const footH = footnote ? 4 * u : 0;
  const chartH = model.chart ? (story ? 9 * u : 6 * u) : 0;

  const bodyTop = area.y + headerH + 3 * u;
  const bodyBottom =
    area.y +
    area.height -
    statsH -
    footH -
    (chartH ? chartH + 3 * u : 0) -
    (stats.length ? 3 * u : 0);
  const body: Rect = {
    x: area.x,
    y: bodyTop,
    width: area.width,
    height: Math.max(10 * u, bodyBottom - bodyTop),
  };

  const titleFont = (s: number) => font(700, s, SANS);
  if (story) {
    const titleFit = fitText(model.title, body.width, titleFont, measure, {
      maxSize: 9 * u,
      minSize: 5 * u,
      maxLines: 3,
    });
    const titleH = titleFit.lines.length * titleFit.size * 0.98;
    drawSwissTitle(
      ctx,
      model,
      p,
      body.x,
      body.y + 2 * u,
      titleFit,
      u,
      body.width,
      measure,
    );
    const matTop =
      body.y + 2 * u + titleH + (model.authors ? 6 * u : 2 * u) + 3 * u;
    const mat: Rect = {
      x: body.x,
      y: matTop,
      width: body.width,
      height: body.y + body.height - matTop,
    };
    drawSwissMat(ctx, model, opts, mat, u);
  } else {
    const matW = landscape ? body.width * 0.3 : body.width * 0.44;
    const mat: Rect = landscape
      ? {
          x: body.x,
          y: body.y,
          width: matW,
          height: area.y + area.height - body.y,
        }
      : {
          x: body.x + body.width - matW,
          y: body.y,
          width: matW,
          height: body.height,
        };
    drawSwissMat(ctx, model, opts, mat, u);
    const textX = landscape ? body.x + matW + 5 * u : body.x;
    const textW = landscape
      ? body.width - matW - 5 * u
      : body.width - matW - 5 * u;
    const titleFit = fitText(model.title, textW, titleFont, measure, {
      maxSize: 8 * u,
      minSize: 4.2 * u,
      maxLines: 4,
    });
    const titleH =
      titleFit.lines.length * titleFit.size * 0.98 +
      (model.authors ? 5 * u : 0);
    const titleY = landscape
      ? body.y + 2 * u
      : body.y + body.height - titleH - (model.stars != null ? 5 * u : 0);
    drawSwissTitle(ctx, model, p, textX, titleY, titleFit, u, textW, measure);
  }

  // Chart strip, stats, footnote
  const statsX = landscape ? area.x + area.width * 0.3 + 5 * u : area.x;
  const statsW = landscape ? area.width * 0.7 - 5 * u : area.width;
  const y = area.y + area.height - footH - statsH;
  if (model.chart) {
    const r: Rect = {
      x: statsX,
      y: y - chartH - (stats.length ? 3 * u : 0),
      width: statsW,
      height: chartH,
    };
    const bars = chartBars(model.chart.points, r, {
      maxBars: story ? 30 : 36,
      gapRatio: 0.35,
    });
    for (const b of bars) {
      ctx.fillStyle = b.best ? p.ink : withAlpha(p.ink, 0.42);
      ctx.fillRect(b.x, b.y, b.width, b.height);
    }
  }
  if (stats.length) {
    hairline(ctx, statsX, y, statsX + statsW, rule);
    const colW = statsW / stats.length;
    stats.forEach((s, i) => {
      const x = statsX + i * colW;
      ctx.fillStyle = p.ink;
      const nf = font(600, (stats.length > 3 ? 5.2 : 6) * u, MONO);
      ctx.font = nf;
      ctx.textAlign = 'left';
      const value =
        s.key === 'days' && s.value.length === 1 ? `0${s.value}` : s.value;
      ctx.fillText(value, x, y + 3 * u + 5 * u);
      if (s.key === 'rating') {
        const vw = ctx.measureText(value).width;
        drawStar(ctx, x + vw + 1.2 * u, y + 4.6 * u, 2.4 * u, p.ink);
      }
      ctx.fillStyle = p.inkMuted;
      ctx.font = font(500, 2.5 * u, SANS);
      ctx.fillText(s.label, x, y + 3 * u + 8.6 * u);
    });
  }
  if (footnote) {
    ctx.fillStyle = p.inkMuted;
    const ff = font(500, 2.1 * u, MONO);
    ctx.font = ff;
    ctx.textAlign = 'left';
    ctx.fillText(
      truncate(footnote, statsW, ff, measure),
      statsX,
      area.y + area.height - 0.6 * u,
    );
  }
}

function drawSwissTitle(
  ctx: Ctx,
  model: ShareCardModel,
  p: CardPalette,
  x: number,
  y: number,
  fit: { size: number; lines: string[] },
  u: number,
  width: number,
  measure: MeasureText,
) {
  ctx.fillStyle = p.ink;
  ctx.textAlign = 'left';
  ctx.font = font(700, fit.size, SANS);
  fit.lines.forEach((line, i) =>
    ctx.fillText(line, x - fit.size * 0.03, y + fit.size * (0.86 + i * 0.98)),
  );
  let cy = y + fit.lines.length * fit.size * 0.98;
  if (model.authors) {
    const af = font(400, 3.15 * u, SANS);
    ctx.font = af;
    ctx.fillStyle = p.ink;
    ctx.fillText(truncate(model.authors, width, af, measure), x, cy + 4.4 * u);
    cy += 5 * u;
  }
  if (model.stars != null)
    drawStars(ctx, x, cy + 1.6 * u, 2.6 * u, model.stars, p.ink, 0.2);
}

function drawSwissMat(
  ctx: Ctx,
  model: ShareCardModel,
  opts: ShareCardRenderOptions,
  mat: Rect,
  u: number,
) {
  ctx.fillStyle = opts.palette.mat;
  ctx.fillRect(mat.x, mat.y, mat.width, mat.height);
  const box = containRect(coverAspect(opts.cover), {
    x: mat.x + mat.width * 0.16,
    y: mat.y + mat.height * 0.12,
    width: mat.width * 0.68,
    height: mat.height * 0.76,
  });
  drawCover(ctx, opts, model, box, {
    radius: 0.3 * u,
    shadow: { color: 'rgba(40,30,40,0.3)', blur: 2.5 * u, y: 1 * u },
  });
}

// ---------------------------------------------------------------------------
// 4 · Duotone
// ---------------------------------------------------------------------------

function renderDuotone(
  ctx: Ctx,
  model: ShareCardModel,
  opts: ShareCardRenderOptions,
) {
  const { width: W, height: H } = formatSize(opts.format);
  const u = unitFor(opts.format, W);
  const p = opts.palette;
  const measure = measurer(ctx);
  const insets = safeInsets(opts.format);
  const story = opts.format === 'story';
  const landscape = opts.format === 'landscape';
  const stats = shareCardStats(model);

  ctx.fillStyle = p.duoLight;
  ctx.fillRect(0, 0, W, H);

  const footerH = landscape ? H : story ? insets.bottom + 30 * u : 23 * u;
  const field: Rect = landscape
    ? { x: 0, y: 0, width: W * 0.58, height: H }
    : { x: 0, y: 0, width: W, height: H - footerH };

  ctx.save();
  ctx.beginPath();
  ctx.rect(field.x, field.y, field.width, field.height);
  ctx.clip();
  ctx.fillStyle = p.duo;
  ctx.fillRect(field.x, field.y, field.width, field.height);
  ctx.fillStyle = p.duoShade;
  ctx.beginPath();
  const r = Math.max(field.width, field.height) * 0.46;
  ctx.arc(
    field.x + field.width * 0.69,
    field.y + field.height * 0.04,
    r,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
  hairline(
    ctx,
    landscape ? field.width : 0,
    landscape ? 0 : field.height,
    landscape ? field.width + 1.5 : W,
    withAlpha(p.duoInk, 0.33),
  );
  if (landscape) {
    ctx.fillStyle = withAlpha(p.duoInk, 0.33);
    ctx.fillRect(field.width, 0, 1.5, H);
  }

  const coverArea: Rect = story
    ? {
        x: field.width * 0.2,
        y: insets.top,
        width: field.width * 0.6,
        height: field.height - insets.top - 9 * u,
      }
    : {
        x: field.x + field.width * 0.22,
        y: field.y + field.height * 0.1,
        width: field.width * 0.56,
        height: field.height * 0.8,
      };
  const cover = containRect(coverAspect(opts.cover), coverArea);
  drawCover(ctx, opts, model, cover, {
    radius: 0.2 * u,
    hardShadow: { dx: 3.5 * u, dy: 4 * u, color: p.duoInk },
  });

  // Footer content
  const foot: Rect = landscape
    ? {
        x: field.width + 6 * u,
        y: insets.top,
        width: W - field.width - 6 * u - insets.right,
        height: H - insets.top - insets.bottom,
      }
    : story
      ? {
          x: insets.left,
          y: field.height + 5 * u,
          width: W - insets.left - insets.right,
          height: footerH - insets.bottom - 5 * u,
        }
      : { x: 7 * u, y: field.height, width: W - 14 * u, height: footerH };
  const markSize = (landscape ? 12 : 12.5) * u;
  ctx.textAlign = 'left';

  if (landscape) {
    const titleFit = fitText(
      model.title,
      foot.width,
      (s) => font(700, s, SANS),
      measure,
      { maxSize: 6 * u, minSize: 3.6 * u, maxLines: 3 },
    );
    ctx.fillStyle = p.duoInk;
    ctx.font = font(700, titleFit.size, SANS);
    titleFit.lines.forEach((line, i) =>
      ctx.fillText(line, foot.x, foot.y + titleFit.size * (0.9 + i * 1.05)),
    );
    let y = foot.y + titleFit.lines.length * titleFit.size * 1.05;
    if (model.authors) {
      const af = font(500, 3 * u, SANS);
      ctx.font = af;
      ctx.fillText(
        truncate(model.authors, foot.width, af, measure),
        foot.x,
        y + 4 * u,
      );
      y += 5 * u;
    }
    const statTop = y + 6 * u;
    stats.slice(0, 4).forEach((s, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      drawDuoStat(
        ctx,
        s,
        foot.x + col * (foot.width / 2),
        statTop + row * 15 * u,
        8 * u,
        2.8 * u,
        p,
        u,
      );
    });
    if (model.showLogo)
      drawMark(
        ctx,
        foot.x + foot.width - markSize,
        foot.y + foot.height - markSize,
        markSize,
        p.duoInk,
      );
    return;
  }

  const centerY = foot.y + foot.height / 2;
  if (stats.length) {
    const gap = (stats.length > 3 ? 4.5 : 7) * u;
    const avail = foot.width - (model.showLogo ? markSize + 4 * u : 0);
    const widthAt = (size: number) =>
      stats.reduce(
        (sum, s) => {
          const valueW =
            measure(s.value, font(650, size, SANS)) +
            (s.key === 'rating' ? size * 0.38 + 0.8 * u : 0);
          const labelW = measure(s.label, font(550, 2.8 * u, SANS));
          return sum + Math.max(valueW, labelW);
        },
        gap * (stats.length - 1),
      );
    let numSize = 8.9 * u;
    while (numSize > 4 * u && widthAt(numSize) > avail) numSize -= 0.25 * u;
    let x = foot.x;
    for (const s of stats) {
      const w = drawDuoStat(
        ctx,
        s,
        x,
        centerY - (numSize + 3.6 * u) / 2,
        numSize,
        2.8 * u,
        p,
        u,
      );
      x += w + gap;
    }
  } else {
    const maxW = foot.width - (model.showLogo ? markSize + 4 * u : 0);
    const tf = font(700, 5 * u, SANS);
    ctx.fillStyle = p.duoInk;
    ctx.font = tf;
    ctx.fillText(
      truncate(model.title, maxW, tf, measure),
      foot.x,
      centerY - (model.authors ? 0.4 * u : -1.8 * u),
    );
    if (model.authors) {
      const af = font(500, 2.8 * u, SANS);
      ctx.font = af;
      ctx.fillText(
        truncate(model.authors, maxW, af, measure),
        foot.x,
        centerY + 4 * u,
      );
    }
  }
  if (model.showLogo)
    drawMark(
      ctx,
      foot.x + foot.width - markSize,
      centerY - markSize / 2,
      markSize,
      p.duoInk,
    );
}

function drawDuoStat(
  ctx: Ctx,
  s: ShareCardStat,
  x: number,
  top: number,
  numSize: number,
  labelSize: number,
  p: CardPalette,
  u: number,
) {
  ctx.fillStyle = p.duoInk;
  const nf = font(650, numSize, SANS);
  ctx.font = nf;
  ctx.fillText(s.value, x, top + numSize * 0.86);
  let w = ctx.measureText(s.value).width;
  if (s.key === 'rating') {
    const ss = numSize * 0.38;
    drawStar(
      ctx,
      x + w + 0.8 * u,
      top + numSize * 0.86 - ss * 1.15,
      ss,
      p.duoInk,
    );
    w += ss + 0.8 * u;
  }
  ctx.font = font(550, labelSize, SANS);
  ctx.fillText(s.label, x, top + numSize + labelSize * 1.3);
  return Math.max(w, ctx.measureText(s.label).width);
}

// ---------------------------------------------------------------------------
// 5 · Pace overlay / frame
// ---------------------------------------------------------------------------

function renderPaceOverlay(
  ctx: Ctx,
  model: ShareCardModel,
  opts: ShareCardRenderOptions,
) {
  const { width: W, height: H } = formatSize(opts.format);
  const u = unitFor(opts.format, W);
  const measure = measurer(ctx);
  const area = insetRect({ width: W, height: H }, safeInsets(opts.format));
  const story = opts.format === 'story';
  const landscape = opts.format === 'landscape';

  const themed = opts.background === 'theme';
  const text = themed ? opts.theme.text : '#ffffff';
  const muted = themed ? opts.theme.muted : 'rgba(255,255,255,0.86)';
  const line = themed ? opts.theme.accent : '#ffffff';
  const shadow: Shadow = themed
    ? null
    : opts.background === 'transparent'
      ? { color: 'rgba(0,0,0,0.55)', blur: 1.6 * u, y: 0.25 * u }
      : { color: 'rgba(0,0,0,0.4)', blur: 1.2 * u, y: 0.2 * u };

  if (opts.background === 'transparent') ctx.clearRect(0, 0, W, H);
  else if (themed) {
    ctx.fillStyle = opts.theme.bg;
    ctx.fillRect(0, 0, W, H);
  } else drawSoftCover(ctx, opts, W, H);

  applyShadow(ctx, shadow);

  // Header: eyebrow and lockup
  const capFont = font(600, 1.9 * u, SANS);
  ctx.fillStyle = muted;
  drawTracked(
    ctx,
    model.eyebrow.toUpperCase(),
    area.x,
    area.y + 2.6 * u,
    capFont,
    0.42 * u,
  );
  if (model.showLogo) {
    drawLockup(
      ctx,
      area.x + area.width,
      area.y - 0.2 * u,
      3.8 * u,
      themed ? opts.theme.accent : text,
      text,
      'right',
    );
  }

  // Footer pill
  const pillH = (landscape ? 9 : 8.6) * u;
  const pillY = area.y + area.height - pillH;
  drawCoverPill(
    ctx,
    model,
    opts,
    { x: area.x, y: pillY, width: area.width, height: pillH },
    u,
    text,
    themed,
    shadow,
    measure,
  );

  // Center block
  const centerTop = area.y + 8 * u;
  const centerBottom = pillY - 6 * u;
  const numSize = (landscape ? 10 : story ? 13 : 10.5) * u;
  const nums: { cap: string; value: string; unit: string }[] = [];
  if (model.progressPercent != null)
    nums.push({
      cap: model.status === 'dnf' ? 'Reached' : 'Progress',
      value: String(Math.round(model.progressPercent)),
      unit: '%',
    });
  if (model.durationDays != null && nums.length < 2)
    nums.push({
      cap: model.durationOverlayCaption,
      value: formatCount(model.durationDays),
      unit: model.durationDays === 1 ? 'day' : 'days',
    });
  if (model.pages != null && nums.length < 2)
    nums.push({
      cap: model.pagesOverlayCaption,
      value: formatCount(model.pages),
      unit: 'pages',
    });
  if (nums.length === 0 && model.stars != null)
    nums.push({ cap: 'Rated', value: model.stars.toFixed(1), unit: '★' });
  const numsH = nums.length ? numSize + 4 * u : 0;
  const tickH = 4 * u;
  const curveMax = (story ? 60 : landscape ? 22 : 30) * u;
  const avail = centerBottom - centerTop;
  const curveH = model.chart
    ? Math.max(8 * u, Math.min(curveMax, avail - numsH - tickH - 5 * u))
    : 0;
  const summaryLine = !model.chart
    ? [
        model.pagesPerDay != null
          ? `${formatPace(model.pagesPerDay)} pages a day`
          : null,
        model.dateRange,
        model.yearOrdinal,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const blockH =
    numsH +
    (model.chart ? 4 * u + curveH + tickH : 0) +
    (summaryLine ? 6 * u : 0);
  let y = centerTop + Math.max(0, (avail - blockH) / 2);

  if (nums.length) {
    nums.forEach((n, i) => {
      const right = i === 1;
      const x = right ? area.x + area.width : area.x;
      ctx.fillStyle = muted;
      drawTracked(
        ctx,
        n.cap.toUpperCase(),
        x,
        y + 2 * u,
        capFont,
        0.42 * u,
        right ? 'right' : 'left',
      );
      const nf = font(750, numSize, SANS);
      const uf = font(600, numSize * 0.34, SANS);
      ctx.font = nf;
      const vw = ctx.measureText(n.value).width;
      ctx.font = uf;
      const uw = ctx.measureText(n.unit).width;
      const total = vw + 0.8 * u + uw;
      const left = right ? x - total : x;
      ctx.fillStyle = text;
      ctx.textAlign = 'left';
      ctx.font = nf;
      ctx.fillText(n.value, left - numSize * 0.03, y + 3 * u + numSize * 0.88);
      ctx.font = uf;
      ctx.fillText(n.unit, left + vw + 0.8 * u, y + 3 * u + numSize * 0.88);
    });
    y += numsH;
  }

  if (model.chart) {
    y += 4 * u;
    const rect: Rect = { x: area.x, y, width: area.width, height: curveH };
    ctx.fillStyle = themed
      ? withAlpha(opts.theme.muted, 0.5)
      : 'rgba(255,255,255,0.45)';
    ctx.fillRect(rect.x, rect.y + rect.height + 0.6 * u, rect.width, 1.5);
    const pts = curvePoints(model.chart.points, rect);
    ctx.strokeStyle = line;
    ctx.lineWidth = 0.55 * u;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((pt, i) =>
      i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y),
    );
    ctx.stroke();
    ctx.fillStyle = line;
    model.chart.points.forEach((point, i) => {
      if (!point.checkpoint || i === model.chart!.points.length - 1) return;
      const pt = pts[i + 1]!;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 0.6 * u, 0, Math.PI * 2);
      ctx.fill();
    });
    const start = pts[0]!;
    ctx.lineWidth = 0.35 * u;
    ctx.beginPath();
    ctx.arc(start.x, start.y, 0.7 * u, 0, Math.PI * 2);
    ctx.stroke();
    const end = pts[pts.length - 1]!;
    ctx.beginPath();
    ctx.arc(end.x, end.y, 1.1 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.25 * u;
    ctx.beginPath();
    ctx.arc(end.x, end.y, 2.1 * u, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    y += curveH;

    const tf = font(500, 1.9 * u, MONO);
    ctx.font = tf;
    ctx.fillStyle = muted;
    const ty = y + 4 * u;
    ctx.textAlign = 'left';
    ctx.fillText(model.chart.startLabel, area.x, ty);
    ctx.textAlign = 'right';
    ctx.fillText(model.chart.endLabel, area.x + area.width, ty);
    if (model.pagesPerDay != null) {
      ctx.textAlign = 'center';
      ctx.fillText(
        `${formatPace(model.pagesPerDay)} p/day`,
        area.x + area.width / 2,
        ty,
      );
    }
    ctx.textAlign = 'left';
    y += tickH;
  }
  if (summaryLine) {
    const sf = font(500, 2.4 * u, SANS);
    ctx.font = sf;
    ctx.fillStyle = muted;
    ctx.fillText(
      truncate(summaryLine, area.width, sf, measure),
      area.x,
      y + 5 * u,
    );
  }
  applyShadow(ctx, null);
}

function drawCoverPill(
  ctx: Ctx,
  model: ShareCardModel,
  opts: ShareCardRenderOptions,
  slot: Rect,
  u: number,
  text: string,
  themed: boolean,
  shadow: Shadow,
  measure: MeasureText,
) {
  const thumbH = slot.height - 2 * u;
  const thumbW = thumbH * coverAspect(opts.cover);
  const titleFont = font(400, 2.8 * u, SERIF, true);
  const authorFont = font(500, 2.2 * u, SANS);
  const starsW =
    model.stars != null ? 2.4 * u * 5 + 2.4 * u * 0.22 * 4 + 2.4 * u : 0;
  const fixed = 1 * u + thumbW + 2 * u + 3 * u + starsW;
  const maxText = slot.width - fixed;
  const title = truncate(
    model.title,
    maxText * (model.authors ? 0.62 : 1),
    titleFont,
    measure,
  );
  const titleW = measure(title, titleFont);
  const sep = model.authors ? '  ·  ' : '';
  const sepW = sep ? measure(sep, authorFont) : 0;
  const author = model.authors
    ? truncate(
        model.authors,
        Math.max(0, maxText - titleW - sepW),
        authorFont,
        measure,
      )
    : '';
  const authorW = author ? measure(author, authorFont) : 0;
  const width = Math.min(slot.width, fixed + titleW + sepW + authorW);
  const pill: Rect = {
    x: slot.x + (slot.width - width) / 2,
    y: slot.y,
    width,
    height: slot.height,
  };

  ctx.save();
  applyShadow(ctx, null);
  ctx.fillStyle = themed ? 'rgba(127,127,127,0.12)' : 'rgba(20, 14, 10, 0.3)';
  roundRectPath(ctx, pill, pill.height / 2);
  ctx.fill();
  ctx.strokeStyle = themed
    ? 'rgba(127,127,127,0.28)'
    : 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  const thumb: Rect = {
    x: pill.x + 1 * u + (pill.height - thumbH) / 2,
    y: pill.y + (pill.height - thumbH) / 2,
    width: thumbW,
    height: thumbH,
  };
  ctx.save();
  applyShadow(ctx, null);
  drawCover(ctx, opts, model, thumb, { radius: 0.5 * u });
  ctx.restore();
  applyShadow(ctx, shadow);

  let x = thumb.x + thumbW + 2 * u;
  const baseline = pill.y + pill.height / 2 + 1 * u;
  ctx.textAlign = 'left';
  ctx.fillStyle = text;
  ctx.font = titleFont;
  ctx.fillText(title, x, baseline);
  x += titleW;
  if (author) {
    ctx.font = authorFont;
    ctx.globalAlpha = 0.65;
    ctx.fillText(sep, x, baseline);
    ctx.globalAlpha = 1;
    x += sepW;
    ctx.fillText(author, x, baseline);
    x += authorW;
  }
  if (model.stars != null) {
    drawStars(
      ctx,
      x + 2.4 * u,
      pill.y + (pill.height - 2.4 * u) / 2,
      2.4 * u,
      model.stars,
      themed ? opts.theme.accent : '#ffffff',
      0.35,
    );
  }
}

// ---------------------------------------------------------------------------

/** Draws the card. The context's canvas must match `formatSize(format)`. */
export function renderShareCard(
  ctx: Ctx,
  model: ShareCardModel,
  opts: ShareCardRenderOptions,
) {
  const { width: W, height: H } = formatSize(opts.format);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  switch (opts.preset) {
    case 'editorialSplit':
      renderEditorialSplit(ctx, model, opts);
      break;
    case 'swissGrid':
      renderSwissGrid(ctx, model, opts);
      break;
    case 'duotone':
      renderDuotone(ctx, model, opts);
      break;
    case 'paceOverlay':
      renderPaceOverlay(ctx, model, opts);
      break;
    default:
      renderCoverPalette(ctx, model, opts);
  }
  ctx.restore();
}

/** Whether the card has a transparent background. */
export function isTransparentCard(
  opts: Pick<ShareCardRenderOptions, 'preset' | 'background'>,
) {
  return opts.preset === 'paceOverlay' && opts.background === 'transparent';
}
