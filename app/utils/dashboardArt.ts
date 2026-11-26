import type {
  DashboardCounts,
  DashboardListKey,
} from '#shared/types/dashboard';

/** Card art styles a dashboard tile can use. */
export const CARD_ART_STYLES = [
  'collage',
  'fan',
  'stack',
  'shelf',
  'pile',
  'wall',
] as const;
export type CardArtStyle = (typeof CARD_ART_STYLES)[number];
export type CardArtDefault = 'auto' | CardArtStyle;

export const CARD_ART_LABELS: Record<CardArtStyle, string> = {
  collage: 'Collage',
  fan: 'Fan',
  stack: 'Stack',
  shelf: 'Shelf',
  pile: 'Pile',
  wall: 'Wall',
};

/** "Auto" gives each list its own signature style. */
export const AUTO_CARD_ART: Record<DashboardListKey | 'shelf', CardArtStyle> = {
  reading: 'stack',
  to_be_read: 'fan',
  finished: 'shelf',
  dnf: 'stack',
  none: 'pile',
  shelf: 'fan',
};

/** Art styles for the All books card. */
export const LIBRARY_ART_STYLES = ['wall', 'pile', 'shelf'] as const;
export type LibraryArtStyle = (typeof LIBRARY_ART_STYLES)[number];

/**
 * How many books each pile holds: Auto, or a whole number from 1 to
 * MAX_PILE_SIZE. Auto keeps the defaults: 24 on the All books card (20 when
 * narrow) and 10 on a tile.
 */
export type PileSize = 'auto' | number;
export const MAX_PILE_SIZE = 250;
/** The size Custom starts at. */
export const DEFAULT_CUSTOM_PILE_SIZE = 50;
export const AUTO_LIBRARY_PILE = 24;
export const AUTO_LIBRARY_PILE_NARROW = 20;
export const AUTO_TILE_PILE = 10;

/** Books to request for a pile: the reader's size, or Auto's default. */
export function pileSampleSize(size: PileSize, library: boolean): number {
  if (size !== 'auto') return size;
  return library ? AUTO_LIBRARY_PILE : AUTO_TILE_PILE;
}

/** Pour speed levels: how quickly a pile's books pour in. */
export const MIN_POUR_SPEED = 1;
export const MAX_POUR_SPEED = 10;
export const DEFAULT_POUR_SPEED = 5;

export const PILE_POUR_MODES = ['staggered', 'together', 'none'] as const;
export type PilePourMode = (typeof PILE_POUR_MODES)[number];

/** How much longer (above 1) or shorter (below 1) a pour takes than the default. */
export function pourTimeScale(level: number): number {
  const clamped = Math.min(MAX_POUR_SPEED, Math.max(MIN_POUR_SPEED, level));
  return DEFAULT_POUR_SPEED / clamped;
}

/**
 * Cover height for a pile of `count` books. Bigger piles than `reference`
 * get smaller covers so the heap stays readable.
 */
export function pileCoverHeight(
  base: number,
  count: number,
  reference: number,
): number {
  return count > reference ? base * (reference / count) ** 0.3 : base;
}

/** Motion for the All books wall. More directions may follow. */
export const WALL_MOTIONS = ['off', 'up'] as const;
export type WallMotion = (typeof WALL_MOTIONS)[number];

/** Drift speed levels. Each level adds 3 CSS pixels per second. */
export const MIN_WALL_DRIFT_SPEED = 1;
export const MAX_WALL_DRIFT_SPEED = 10;
export const DEFAULT_WALL_DRIFT_SPEED = 3;

/** Pixels per second for a drift speed level (the default, 3, is 9 px/s). */
export function wallDriftPxPerSecond(level: number): number {
  return (
    3 * Math.min(MAX_WALL_DRIFT_SPEED, Math.max(MIN_WALL_DRIFT_SPEED, level))
  );
}

export type DashboardSettings = {
  showStatusBar: boolean;
  /** All books card art. */
  libraryArt: LibraryArtStyle;
  /** Whether the All books wall slowly drifts, and which way. */
  wallMotion: WallMotion;
  /** Drift speed level, from 1 (slowest) to 10. */
  wallDriftSpeed: number;
  /** Books in each pile, on the All books card and on tiles. */
  pileSize: PileSize;
  /** Whether the All books shelf shows only books with spine artwork. */
  shelfSpinesOnly: boolean;
  pilePourMode: PilePourMode;
  /** How quickly a pile's books pour in, from 1 (slowest) to 10. */
  pourSpeed: number;
  cardArt: {
    default: CardArtDefault;
    /** Per-tile choices keyed by list key (`reading`, `shelf:<id>`, …). */
    overrides: Record<string, CardArtStyle>;
  };
};

const MAX_CARD_ART_OVERRIDES = 200;

export function defaultDashboardSettings(): DashboardSettings {
  return {
    showStatusBar: true,
    libraryArt: 'wall',
    wallMotion: 'off',
    wallDriftSpeed: DEFAULT_WALL_DRIFT_SPEED,
    pileSize: 'auto',
    shelfSpinesOnly: false,
    pilePourMode: 'staggered',
    pourSpeed: DEFAULT_POUR_SPEED,
    cardArt: { default: 'auto', overrides: {} },
  };
}

export function isCardArtStyle(value: unknown): value is CardArtStyle {
  return (
    typeof value === 'string' &&
    (CARD_ART_STYLES as readonly string[]).includes(value)
  );
}

/**
 * Validates stored dashboard settings. Override entries that are not a known
 * style (including `null`, which the tile menu writes to reset a tile) are dropped.
 */
export function normalizeDashboardSettings(value: unknown): DashboardSettings {
  const defaults = defaultDashboardSettings();
  if (!value || typeof value !== 'object') return defaults;
  const source = value as Record<string, unknown>;
  const cardArt =
    source.cardArt && typeof source.cardArt === 'object'
      ? (source.cardArt as Record<string, unknown>)
      : {};
  const rawDefault = cardArt.default;
  const overrides: Record<string, CardArtStyle> = {};
  if (cardArt.overrides && typeof cardArt.overrides === 'object') {
    for (const [key, style] of Object.entries(
      cardArt.overrides as Record<string, unknown>,
    )) {
      if (Object.keys(overrides).length >= MAX_CARD_ART_OVERRIDES) break;
      if (key && key.length <= 200 && isCardArtStyle(style))
        overrides[key] = style;
    }
  }
  return {
    showStatusBar:
      typeof source.showStatusBar === 'boolean'
        ? source.showStatusBar
        : defaults.showStatusBar,
    libraryArt: (LIBRARY_ART_STYLES as readonly unknown[]).includes(
      source.libraryArt,
    )
      ? (source.libraryArt as LibraryArtStyle)
      : defaults.libraryArt,
    wallMotion: (WALL_MOTIONS as readonly unknown[]).includes(source.wallMotion)
      ? (source.wallMotion as WallMotion)
      : defaults.wallMotion,
    wallDriftSpeed:
      typeof source.wallDriftSpeed === 'number' &&
      Number.isFinite(source.wallDriftSpeed)
        ? Math.min(
            MAX_WALL_DRIFT_SPEED,
            Math.max(MIN_WALL_DRIFT_SPEED, Math.round(source.wallDriftSpeed)),
          )
        : defaults.wallDriftSpeed,
    pileSize:
      typeof source.pileSize === 'number' && Number.isFinite(source.pileSize)
        ? Math.min(MAX_PILE_SIZE, Math.max(1, Math.round(source.pileSize)))
        : defaults.pileSize,
    pilePourMode:
      PILE_POUR_MODES.find((mode) => mode === source.pilePourMode) ??
      defaults.pilePourMode,
    pourSpeed:
      typeof source.pourSpeed === 'number' && Number.isFinite(source.pourSpeed)
        ? Math.min(
            MAX_POUR_SPEED,
            Math.max(MIN_POUR_SPEED, Math.round(source.pourSpeed)),
          )
        : defaults.pourSpeed,
    shelfSpinesOnly:
      typeof source.shelfSpinesOnly === 'boolean'
        ? source.shelfSpinesOnly
        : defaults.shelfSpinesOnly,
    cardArt: {
      default:
        rawDefault === 'auto' || isCardArtStyle(rawDefault)
          ? rawDefault
          : 'auto',
      overrides,
    },
  };
}

/** The style a tile should use: its override, else the default, else Auto. */
export function resolveCardArt(
  listKey: string,
  kind: DashboardListKey | 'shelf',
  settings: DashboardSettings['cardArt'],
): CardArtStyle {
  const override = settings.overrides[listKey];
  if (override) return override;
  return settings.default === 'auto' ? AUTO_CARD_ART[kind] : settings.default;
}

/** Wall needs four distinct covers so repeats never touch; fewer show as Fan. */
export function displayedCardArt(
  style: CardArtStyle,
  coverCount: number,
): CardArtStyle {
  return style === 'wall' && coverCount < 4 ? 'fan' : style;
}

/**
 * Fills a `cols`-wide grid with `slots` covers. With fewer covers than slots,
 * the column + row×2 stride guarantees (for 4+ covers) that no cover touches a
 * copy of itself beside, above, or diagonally.
 */
export function wallSlots<T>(items: T[], cols: number, slots: number): T[] {
  if (!items.length) return [];
  if (items.length >= slots) return items.slice(0, slots);
  return Array.from(
    { length: slots },
    (_, i) => items[((i % cols) + Math.floor(i / cols) * 2) % items.length]!,
  );
}

/**
 * Which loaded book fills a wall slot, for any row (a drifting wall keeps
 * adding rows). `strided` is for small libraries: the column + row×2 stride
 * keeps copies apart with 4+ books. Otherwise books run in reading order and
 * wrap; with 11+ books in a 9-column wall no copy touches another.
 */
export function wallBookIndex(
  row: number,
  col: number,
  cols: number,
  count: number,
  strided: boolean,
  startIndex = 0,
): number {
  if (count <= 0) return 0;
  const raw = startIndex + (strided ? col + row * 2 : row * cols + col);
  return ((raw % count) + count) % count;
}

export type HeroArtMode = 'wall' | 'wall-small' | 'spotlight' | 'empty';

/** How the All books card draws its art for a given number of covers. */
export function heroArtMode(coverCount: number): HeroArtMode {
  if (coverCount >= 16) return 'wall';
  if (coverCount >= 4) return 'wall-small';
  if (coverCount >= 1) return 'spotlight';
  return 'empty';
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small seeded PRNG (mulberry32): same seed, same sequence. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PilePlacement = {
  /** Left edge, as a fraction of the tile width. */
  x: number;
  /** Top edge, as a fraction of the tile height. */
  y: number;
  /** Rotation in degrees. */
  r: number;
  /** Whether the book drops in from above (default) or starts at rest. */
  drop?: boolean;
};

/** Part of a pile's box the books may occupy, as fractions of its size. */
export type PileRegion = { x0: number; x1: number; y0: number; y1: number };
export const FULL_PILE_REGION: PileRegion = { x0: 0, x1: 1, y0: 0.1, y1: 1 };

/**
 * Seeded scatter for a pile: the same seed and books give the same layout.
 * Callers add a per-page-load value to the seed for a fresh throw each visit.
 * `aspect` is box width ÷ height; `coverHeight` is a fraction of box height.
 */
export function pileLayout(
  ids: string[],
  seedKey: string,
  options: {
    aspect?: number;
    coverHeight?: number;
    region?: PileRegion;
  } = {},
): PilePlacement[] {
  const { aspect = 1, coverHeight = 0.5, region = FULL_PILE_REGION } = options;
  const random = seededRandom(hashString(`${seedKey}:${ids.join(',')}`));
  const coverWidth = (coverHeight * 2) / 3 / aspect;
  const xMin = region.x0 - 0.03;
  const xMax = Math.max(xMin, region.x1 + 0.03 - coverWidth);
  const yMin = region.y0 + 0.02;
  const yMax = Math.max(yMin, region.y1 - coverHeight * 0.95);
  return ids.map(() => ({
    x: xMin + random() * (xMax - xMin),
    y: yMin + random() * (yMax - yMin),
    r: (random() - 0.5) * 44,
  }));
}

/** Books a pile shows, and the size of the list they were picked from. */
export type HeldPile<T> = {
  /** How many books the list held when these were picked. */
  count: number;
  /**
   * False when the books are not yet a sample of the right size (an older
   * cached response, or one picked for another pile size). Such a pile shows
   * no books until a fitting sample arrives.
   */
  random: boolean;
  books: T[];
};

/**
 * Keeps the books a pile already shows when fresh data arrives, so a refresh
 * does not swap them out (each response carries a new random sample). A new
 * sample replaces them when the list changed size, or when the held books
 * were not a fitting sample.
 */
export function holdPile<T>(
  held: HeldPile<T> | undefined,
  next: HeldPile<T>,
): HeldPile<T> {
  if (!held || held.count !== next.count) return next;
  return !held.random && next.random ? next : held;
}

export const STATUS_ORDER: DashboardListKey[] = [
  'reading',
  'to_be_read',
  'finished',
  'dnf',
  'none',
];

export const STATUS_LABELS: Record<DashboardListKey, string> = {
  reading: 'Reading',
  to_be_read: 'To be read',
  finished: 'Finished',
  dnf: 'DNF',
  none: 'No status',
};

/** Non-empty status segments for the library status bar, as percentages. */
export function statusSegments(
  counts: DashboardCounts,
): { key: DashboardListKey; count: number; percent: number }[] {
  if (!counts.total) return [];
  return STATUS_ORDER.filter((key) => counts[key] > 0).map((key) => ({
    key,
    count: counts[key],
    percent: (counts[key] / counts.total) * 100,
  }));
}
