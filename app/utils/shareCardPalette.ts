/**
 * Cover palette extraction for share cards.
 *
 * Colors are clustered in OKLab, which is perceptually uniform, so the
 * resulting swatches match what a reader sees on the cover. Every function in
 * this module is pure: it takes pixel data and returns colors, so the palette
 * can be unit tested without a browser.
 */

export type Oklab = { L: number; a: number; b: number };
export type Oklch = { L: number; C: number; h: number };
export type Rgb = { r: number; g: number; b: number };

export type PaletteSwatch = {
  color: Oklab;
  /** Share of the sampled pixels in this cluster, 0..1. */
  weight: number;
};

/** Colors that every share card style draws with. All values are hex strings. */
export type CardPalette = {
  /** Darkest background tone. */
  deeper: string;
  /** Dark background tone, the base of cover-tinted panels. */
  deep: string;
  /** Mid tone for radial glows over the dark background. */
  glow: string;
  /** The cover's most characterful color, for marks and highlights. */
  accent: string;
  /** Light text over the dark tones. */
  onDeep: string;
  /** Muted light text over the dark tones. */
  onDeepMuted: string;
  /** Warm light surface for editorial and Swiss styles. */
  paper: string;
  /** Muted mat behind the cover on the paper surface. */
  mat: string;
  /** Dark ink for text over paper. */
  ink: string;
  /** Muted ink for captions over paper. */
  inkMuted: string;
  /** Duotone field, a bold version of the accent. */
  duo: string;
  /** Darker duotone tone for shapes over the field. */
  duoShade: string;
  /** Lighter duotone tone for the footer band. */
  duoLight: string;
  /** Ink over the duotone colors. */
  duoInk: string;
};

const DEFAULT_SEED: Oklab = oklchToOklab({ L: 0.42, C: 0.06, h: 195 });

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
}

export function rgbToOklab({ r, g, b }: Rgb): Oklab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Converts to sRGB without clamping; channels may fall outside 0..255. */
export function oklabToRgbUnclamped({ L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

export function oklabToOklch({ L, a, b }: Oklab): Oklch {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

export function oklchToOklab({ L, C, h }: Oklch): Oklab {
  const rad = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

function inGamut({ r, g, b }: Rgb): boolean {
  const eps = 0.5;
  return (
    r >= -eps &&
    r <= 255 + eps &&
    g >= -eps &&
    g <= 255 + eps &&
    b >= -eps &&
    b <= 255 + eps
  );
}

/**
 * Converts an OKLCH color to hex. Out-of-gamut colors keep their lightness
 * and hue and lose chroma until they fit in sRGB.
 */
export function oklchToHex(color: Oklch): string {
  const L = Math.min(1, Math.max(0, color.L));
  let lo = 0;
  let hi = Math.max(0, color.C);
  let rgb = oklabToRgbUnclamped(oklchToOklab({ L, C: hi, h: color.h }));
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const candidate = oklabToRgbUnclamped(
        oklchToOklab({ L, C: mid, h: color.h }),
      );
      if (inGamut(candidate)) lo = mid;
      else hi = mid;
    }
    rgb = oklabToRgbUnclamped(oklchToOklab({ L, C: lo, h: color.h }));
  }
  const hex = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1] as string;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function distSq(p: Oklab, q: Oklab): number {
  const dL = p.L - q.L;
  const da = p.a - q.a;
  const db = p.b - q.b;
  return dL * dL + da * da + db * db;
}

/**
 * Clusters RGBA pixel data into at most `k` OKLab swatches, sorted by weight.
 * Transparent pixels are skipped. The result is deterministic for a given
 * input: centroids start from evenly spaced lightness quantiles.
 */
export function extractSwatches(
  data: ArrayLike<number>,
  k = 5,
  iterations = 8,
): PaletteSwatch[] {
  const points: Oklab[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    if ((data[i + 3] as number) < 128) continue;
    points.push(
      rgbToOklab({
        r: data[i] as number,
        g: data[i + 1] as number,
        b: data[i + 2] as number,
      }),
    );
  }
  if (points.length === 0) return [];

  const sorted = [...points].sort((p, q) => p.L - q.L);
  const count = Math.min(k, points.length);
  let centroids: Oklab[] = Array.from({ length: count }, (_, i) => {
    const idx = Math.floor(((i + 0.5) / count) * sorted.length);
    return { ...(sorted[Math.min(idx, sorted.length - 1)] as Oklab) };
  });
  const assignment = new Array<number>(points.length).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    for (let p = 0; p < points.length; p++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = distSq(points[p] as Oklab, centroids[c] as Oklab);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assignment[p] = best;
    }
    const sums = centroids.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (let p = 0; p < points.length; p++) {
      const s = sums[assignment[p] as number]!;
      const pt = points[p] as Oklab;
      s.L += pt.L;
      s.a += pt.a;
      s.b += pt.b;
      s.n += 1;
    }
    centroids = centroids.map((c, i) => {
      const s = sums[i]!;
      return s.n ? { L: s.L / s.n, a: s.a / s.n, b: s.b / s.n } : c;
    });
  }

  const weights = centroids.map(() => 0);
  for (const a of assignment) weights[a] = (weights[a] as number) + 1;
  return centroids
    .map((color, i) => ({
      color,
      weight: (weights[i] as number) / points.length,
    }))
    .filter((s) => s.weight > 0)
    .sort((p, q) => q.weight - p.weight);
}

/** The largest swatch with some color, or the largest swatch overall. */
export function pickDominant(swatches: PaletteSwatch[]): Oklab {
  const colorful = swatches.find(
    (s) => oklabToOklch(s.color).C >= 0.025 && s.weight >= 0.12,
  );
  return (colorful ?? swatches[0])?.color ?? DEFAULT_SEED;
}

/** The most chromatic swatch that covers a noticeable part of the cover. */
export function pickAccent(swatches: PaletteSwatch[]): Oklab {
  let best: PaletteSwatch | null = null;
  let bestScore = -1;
  for (const s of swatches) {
    if (s.weight < 0.03) continue;
    const { L, C } = oklabToOklch(s.color);
    // Prefer vivid mid-tones over near-black or near-white colors.
    const lightness = 1 - Math.abs(L - 0.62) * 1.4;
    const score = C * Math.sqrt(s.weight) * Math.max(0.2, lightness);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best?.color ?? pickDominant(swatches);
}

function clampC(C: number, min: number, max: number) {
  return Math.min(max, Math.max(min, C));
}

/**
 * Builds the card palette from a dominant and an accent color. Lightness is
 * fixed per role so text stays readable however light or dark the cover is.
 */
export function buildCardPalette(dominant: Oklab, accent: Oklab): CardPalette {
  const d = oklabToOklch(dominant);
  const a = oklabToOklch(accent);
  // A near-gray cover has no reliable hue; borrow the accent's or a neutral.
  const baseHue = d.C < 0.02 ? (a.C >= 0.02 ? a.h : 60) : d.h;
  const accentHue = a.C < 0.02 ? baseHue : a.h;
  const baseC = d.C < 0.02 ? Math.min(a.C, 0.03) : d.C;
  const accentC = Math.max(a.C, 0.04);

  return {
    deeper: oklchToHex({
      L: 0.17,
      C: clampC(baseC * 0.55, 0.008, 0.05),
      h: baseHue,
    }),
    deep: oklchToHex({
      L: 0.27,
      C: clampC(baseC * 0.8, 0.012, 0.075),
      h: baseHue,
    }),
    glow: oklchToHex({ L: 0.42, C: clampC(baseC, 0.02, 0.09), h: baseHue }),
    accent: oklchToHex({
      L: 0.72,
      C: clampC(accentC, 0.05, 0.14),
      h: accentHue,
    }),
    onDeep: oklchToHex({ L: 0.94, C: 0.025, h: accentHue }),
    onDeepMuted: oklchToHex({ L: 0.8, C: 0.03, h: accentHue }),
    paper: oklchToHex({
      L: 0.94,
      C: clampC(baseC * 0.25, 0.008, 0.022),
      h: baseHue,
    }),
    mat: oklchToHex({
      L: 0.8,
      C: clampC(baseC * 0.45, 0.012, 0.04),
      h: baseHue,
    }),
    ink: oklchToHex({
      L: 0.24,
      C: clampC(baseC * 0.5, 0.01, 0.045),
      h: baseHue,
    }),
    inkMuted: oklchToHex({
      L: 0.47,
      C: clampC(baseC * 0.4, 0.008, 0.035),
      h: baseHue,
    }),
    duo: oklchToHex({
      L: 0.78,
      C: clampC(accentC * 1.2, 0.07, 0.15),
      h: accentHue,
    }),
    duoShade: oklchToHex({
      L: 0.62,
      C: clampC(accentC * 1.1, 0.06, 0.13),
      h: accentHue,
    }),
    duoLight: oklchToHex({
      L: 0.84,
      C: clampC(accentC, 0.05, 0.13),
      h: accentHue,
    }),
    duoInk: oklchToHex({
      L: 0.24,
      C: clampC(accentC * 0.4, 0.02, 0.05),
      h: accentHue,
    }),
  };
}

/** Builds the palette from cover pixels, or a neutral palette without them. */
export function paletteFromPixels(data: ArrayLike<number> | null): CardPalette {
  const swatches = data ? extractSwatches(data) : [];
  if (swatches.length === 0)
    return buildCardPalette(DEFAULT_SEED, DEFAULT_SEED);
  return buildCardPalette(pickDominant(swatches), pickAccent(swatches));
}

/** Builds the palette from one hex color, such as the theme's main color. */
export function paletteFromHex(hex: string | null | undefined): CardPalette {
  const rgb = hex ? hexToRgb(hex) : null;
  const seed = rgb ? rgbToOklab(rgb) : DEFAULT_SEED;
  return buildCardPalette(seed, seed);
}

/** WCAG relative luminance contrast ratio between two hex colors. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lum = (hex: string) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    return (
      0.2126 * srgbToLinear(rgb.r) +
      0.7152 * srgbToLinear(rgb.g) +
      0.0722 * srgbToLinear(rgb.b)
    );
  };
  const la = lum(hexA);
  const lb = lum(hexB);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
