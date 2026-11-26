/**
 * Layout math for share cards. Nothing here touches a canvas: text
 * measurement is passed in as a function, so every rule can be unit tested.
 */

import {
  SHARE_CARD_FORMATS,
  type ShareCardChartPoint,
  type ShareCardFormat,
} from './shareCardModel';

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Insets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

/** Returns `text` measured in pixels for a CSS font string. */
export type MeasureText = (text: string, font: string) => number;

export function formatSize(format: ShareCardFormat): Size {
  const f =
    SHARE_CARD_FORMATS.find((entry) => entry.value === format) ??
    SHARE_CARD_FORMATS[0];
  return { width: f.width, height: f.height };
}

/**
 * Margins that keep content clear of the edges. Story cards keep the top and
 * bottom bands clear, where Instagram and similar apps draw the profile row
 * and the reply field.
 */
export function safeInsets(format: ShareCardFormat): Insets {
  switch (format) {
    case 'story':
      return { top: 260, right: 88, bottom: 300, left: 88 };
    case 'landscape':
      return { top: 56, right: 64, bottom: 56, left: 64 };
    default:
      return { top: 84, right: 84, bottom: 84, left: 84 };
  }
}

export function insetRect(size: Size, insets: Insets): Rect {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, size.width - insets.left - insets.right),
    height: Math.max(0, size.height - insets.top - insets.bottom),
  };
}

/**
 * Wraps text into at most `maxLines` lines no wider than `maxWidth`. The last
 * line ends in an ellipsis when the text does not fit. A single word that is
 * too wide is cut with an ellipsis as well.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  font: string,
  measure: MeasureText,
  maxLines = 2,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || maxLines < 1) return [];
  const lines: string[] = [];
  let current = '';
  let index = 0;
  while (index < words.length) {
    const word = words[index] as string;
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, font) <= maxWidth) {
      current = candidate;
      index++;
      continue;
    }
    if (!current) {
      // A single word wider than the line.
      current = truncate(word, maxWidth, font, measure);
      index++;
    }
    lines.push(current);
    current = '';
    if (lines.length === maxLines) break;
  }
  if (current) lines.push(current);
  if (index < words.length) {
    const last = lines.length - 1;
    const line = lines[last] as string;
    if (!line.endsWith('…')) {
      const rest = [line, ...words.slice(index)].join(' ');
      lines[last] = truncate(rest, maxWidth, font, measure, true);
    }
  }
  return lines;
}

/** Shortens text until it fits, ending it with an ellipsis. */
export function truncate(
  text: string,
  maxWidth: number,
  font: string,
  measure: MeasureText,
  forceEllipsis = false,
): string {
  if (!forceEllipsis && measure(text, font) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${text.slice(0, mid).trimEnd()}…`;
    if (measure(candidate, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

export type FittedText = { size: number; lines: string[] };

/**
 * Picks the largest font size, stepping down from `maxSize` to `minSize`, at
 * which the text fits in `maxLines` lines without an ellipsis. At `minSize`
 * the text is wrapped and truncated.
 */
export function fitText(
  text: string,
  maxWidth: number,
  fontAt: (size: number) => string,
  measure: MeasureText,
  opts: { maxSize: number; minSize: number; maxLines: number; step?: number },
): FittedText {
  const step = opts.step ?? 2;
  for (let size = opts.maxSize; size > opts.minSize; size -= step) {
    const lines = wrapText(
      text,
      maxWidth,
      fontAt(size),
      measure,
      opts.maxLines,
    );
    // A cut word on any line, not only the last, means the size is too big.
    if (text.trim().endsWith('…') || !lines.some((l) => l.endsWith('…'))) {
      return { size, lines };
    }
  }
  return {
    size: opts.minSize,
    lines: wrapText(
      text,
      maxWidth,
      fontAt(opts.minSize),
      measure,
      opts.maxLines,
    ),
  };
}

/** Fits an image of `aspect` (width / height) inside a box, centered. */
export function containRect(aspect: number, box: Rect): Rect {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 2 / 3;
  let width = box.width;
  let height = width / a;
  if (height > box.height) {
    height = box.height;
    width = height * a;
  }
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/** Scales an image of `aspect` to cover a box, centered and cropped. */
export function coverRect(aspect: number, box: Rect): Rect {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 2 / 3;
  let width = box.width;
  let height = width / a;
  if (height < box.height) {
    height = box.height;
    width = height * a;
  }
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

export type StackItem = {
  height: number;
  /** Space before this item. */
  gap?: number;
  /** A flexible item takes the leftover height, between min and max. */
  flex?: { min: number; max: number };
};

/**
 * Lays out items top to bottom inside `area` and centers the block
 * vertically. Flexible items share the leftover height equally. Returns the
 * top y and height of each item.
 */
export function stackLayout(
  items: StackItem[],
  area: { y: number; height: number },
): { y: number; height: number }[] {
  const fixed = items.reduce(
    (sum, item) => sum + (item.gap ?? 0) + (item.flex ? 0 : item.height),
    0,
  );
  const flexItems = items.filter((item) => item.flex);
  const leftover = Math.max(0, area.height - fixed);
  const share = flexItems.length ? leftover / flexItems.length : 0;
  const heights = items.map((item) =>
    item.flex
      ? Math.min(item.flex.max, Math.max(item.flex.min, share))
      : item.height,
  );
  const total = items.reduce(
    (sum, item, i) => sum + (item.gap ?? 0) + (heights[i] as number),
    0,
  );
  let y = area.y + Math.max(0, (area.height - total) / 2);
  return items.map((item, i) => {
    y += item.gap ?? 0;
    const out = { y, height: heights[i] as number };
    y += heights[i] as number;
    return out;
  });
}

export type ChartBar = Rect & { amount: number; best: boolean };

/**
 * Groups daily amounts into at most `maxBars` bars of consecutive days, so a
 * long read still fits in a small chart. Each bar sums its days.
 */
export function bucketAmounts(
  points: ShareCardChartPoint[],
  maxBars: number,
): number[] {
  if (points.length === 0 || maxBars < 1) return [];
  const size = Math.ceil(points.length / maxBars);
  const out: number[] = [];
  for (let i = 0; i < points.length; i += size) {
    out.push(
      points
        .slice(i, i + size)
        .reduce((sum, p) => sum + Math.max(0, p.amount), 0),
    );
  }
  return out;
}

/** Bar geometry for the daily-reading chart, bottom-aligned in `rect`. */
export function chartBars(
  points: ShareCardChartPoint[],
  rect: Rect,
  opts: { maxBars?: number; gapRatio?: number; minBarHeight?: number } = {},
): ChartBar[] {
  const amounts = bucketAmounts(points, opts.maxBars ?? 30);
  if (amounts.length === 0) return [];
  const max = Math.max(...amounts);
  const gapRatio = opts.gapRatio ?? 0.4;
  const slot = rect.width / amounts.length;
  const width = slot * (1 - gapRatio);
  const minH = opts.minBarHeight ?? 2;
  const bestIndex = amounts.indexOf(max);
  return amounts.map((amount, i) => {
    const h =
      max > 0
        ? Math.max(amount > 0 ? minH : 0, (amount / max) * rect.height)
        : 0;
    return {
      x: rect.x + i * slot + (slot - width) / 2,
      y: rect.y + rect.height - h,
      width,
      height: h,
      amount,
      best: i === bestIndex && max > 0,
    };
  });
}

/**
 * Points of the cumulative progress curve inside `rect`. The curve starts at
 * 0% at the left edge (the start of the first day) and has one point at the
 * end of each day.
 */
export function curvePoints(
  points: ShareCardChartPoint[],
  rect: Rect,
): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const n = points.length;
  const out = [{ x: rect.x, y: rect.y + rect.height }];
  points.forEach((p, i) => {
    const pct = Math.min(100, Math.max(0, p.percent));
    out.push({
      x: rect.x + ((i + 1) / n) * rect.width,
      y: rect.y + rect.height - (pct / 100) * rect.height,
    });
  });
  return out;
}
