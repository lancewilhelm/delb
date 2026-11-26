/**
 * Data model for finished-book share cards.
 *
 * `buildShareCardModel` turns the finish-summary response and the reader's
 * toggles into exactly what a card shows. A stat is present only when the
 * reader recorded the data behind it and left its toggle on, so the renderer
 * never needs to invent a value.
 */

export type FinishProgressDay = {
  date: string;
  percent: number;
  deltaPercent: number;
  pages: number | null;
  pagesRead: number | null;
  hasCheckpoint: boolean;
};

/** Response data of `GET /api/books/{id}/finish-summary`. */
export type FinishSummary = {
  book: {
    id: string;
    title: string;
    authors: string[];
    series: { name: string; index: number | null } | null;
    pages: number | null;
    coverImagePath: string | null;
    updatedAt: string;
  };
  status: 'to_be_read' | 'reading' | 'finished' | 'dnf' | null;
  startedAt: string | null;
  finishedAt: string | null;
  startedDate: string | null;
  finishedDate: string | null;
  durationDays: number | null;
  pages: number | null;
  pagesPerDay: number | null;
  rating: number | null;
  finishYear: number | null;
  yearFinishOrdinal: number | null;
  progress: { checkpointCount: number; days: FinishProgressDay[] };
};

export const SHARE_CARD_PRESETS = [
  { value: 'coverPalette', label: 'Cover palette', chart: false },
  { value: 'editorialSplit', label: 'Editorial split', chart: true },
  { value: 'swissGrid', label: 'Swiss grid', chart: true },
  { value: 'duotone', label: 'Duotone', chart: false },
  { value: 'paceOverlay', label: 'Pace overlay', chart: true },
] as const;
export type ShareCardPreset = (typeof SHARE_CARD_PRESETS)[number]['value'];

export const SHARE_CARD_FORMATS = [
  { value: 'square', label: 'Square', width: 1080, height: 1080 },
  { value: 'story', label: 'Story', width: 1080, height: 1920 },
  { value: 'landscape', label: 'Landscape', width: 1200, height: 630 },
] as const;
export type ShareCardFormat = (typeof SHARE_CARD_FORMATS)[number]['value'];

export const SHARE_CARD_BACKGROUNDS = [
  { value: 'theme', label: 'Theme' },
  { value: 'softCover', label: 'Soft cover' },
  { value: 'transparent', label: 'Transparent' },
] as const;
export type ShareCardBackground =
  (typeof SHARE_CARD_BACKGROUNDS)[number]['value'];

export type ShareCardToggles = {
  rating: boolean;
  duration: boolean;
  pages: boolean;
  chart: boolean;
  logo: boolean;
};

export const DEFAULT_SHARE_CARD_TOGGLES: ShareCardToggles = {
  rating: true,
  duration: true,
  pages: true,
  chart: true,
  logo: true,
};

/** The fewest dated checkpoints that make a pace chart worth drawing. */
export const MIN_CHART_CHECKPOINTS = 3;

export type ShareCardStat = {
  key: 'days' | 'pages' | 'pace' | 'rating';
  value: string;
  unit: string;
  label: string;
};

export type ShareCardChartPoint = {
  date: string;
  /** Cumulative progress at the end of the day, 0..100. */
  percent: number;
  /** Amount read on the day, in pages when known, otherwise in percent. */
  amount: number;
  /** Whether the reader logged progress on this day. */
  checkpoint: boolean;
};

export type ShareCardChart = {
  unit: 'pages' | 'percent';
  points: ShareCardChartPoint[];
  bestDay: number;
  startLabel: string;
  endLabel: string;
};

export type ShareCardModel = {
  title: string;
  authors: string;
  /** "Finished · November 2026", or "Finished" without a finish date. */
  eyebrow: string;
  /** "Nov 2026", or null without a finish date. */
  monthLabel: string | null;
  /** "Nov 3 – Nov 11, 2026", or null. */
  dateRange: string | null;
  /** "Book 12 of 2026", or null. */
  yearOrdinal: string | null;
  durationDays: number | null;
  pages: number | null;
  pagesPerDay: number | null;
  /** Stars from 0.5 to 5 in half steps, or null. */
  stars: number | null;
  chart: ShareCardChart | null;
  showLogo: boolean;
};

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function parseYmd(date: string | null | undefined) {
  const m = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month, day: Number(m[3]) };
}

function shortMonth(month: number) {
  return (MONTHS_LONG[month - 1] ?? '').slice(0, 3);
}

/** Formats a YYYY-MM-DD date as "Nov 3". */
export function formatShortDate(date: string | null | undefined): string {
  const d = parseYmd(date);
  return d ? `${shortMonth(d.month)} ${d.day}` : '';
}

/** Formats a start and finish date as a compact range. */
export function formatDateRange(
  start: string | null | undefined,
  finish: string | null | undefined,
): string | null {
  const s = parseYmd(start);
  const f = parseYmd(finish);
  if (!f) return null;
  if (!s) return `${shortMonth(f.month)} ${f.day}, ${f.year}`;
  if (s.year === f.year && s.month === f.month && s.day === f.day) {
    return `${shortMonth(f.month)} ${f.day}, ${f.year}`;
  }
  if (s.year === f.year) {
    return `${shortMonth(s.month)} ${s.day} – ${shortMonth(f.month)} ${f.day}, ${f.year}`;
  }
  return `${shortMonth(s.month)} ${s.day}, ${s.year} – ${shortMonth(f.month)} ${f.day}, ${f.year}`;
}

/** Joins author names: "A", "A & B", or "A, B & C". */
export function formatAuthors(authors: string[]): string {
  const names = authors.map((a) => a.trim()).filter(Boolean);
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} & others`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** Formats an integer with thousands separators: 1234 → "1,234". */
export function formatCount(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Formats pages per day: whole numbers above 10, one decimal below. */
export function formatPace(pagesPerDay: number): string {
  if (pagesPerDay >= 10) return formatCount(pagesPerDay);
  return (Math.round(pagesPerDay * 10) / 10).toString();
}

/** Formats half-star ratings as "4.5". */
export function formatStars(stars: number): string {
  return Number.isInteger(stars) ? `${stars}.0` : stars.toFixed(1);
}

/**
 * Builds the chart from the daily series. It returns null unless the reader
 * logged progress on at least MIN_CHART_CHECKPOINTS separate days, so a book
 * with only a start and a finish never gets a made-up straight line.
 */
export function buildShareCardChart(
  summary: Pick<FinishSummary, 'progress' | 'pages'>,
): ShareCardChart | null {
  const { days, checkpointCount } = summary.progress;
  if (checkpointCount < MIN_CHART_CHECKPOINTS || days.length < 2) return null;
  const withPages = days.every((d) => d.pagesRead != null);
  const points = days.map((d) => ({
    date: d.date,
    percent: d.percent,
    amount: withPages ? (d.pagesRead as number) : d.deltaPercent,
    checkpoint: d.hasCheckpoint,
  }));
  const bestDay = points.reduce((m, p) => Math.max(m, p.amount), 0);
  return {
    unit: withPages ? 'pages' : 'percent',
    points,
    bestDay,
    startLabel: formatShortDate(days[0]?.date),
    endLabel: formatShortDate(days[days.length - 1]?.date),
  };
}

export function buildShareCardModel(
  summary: FinishSummary,
  toggles: ShareCardToggles,
): ShareCardModel {
  const finished = parseYmd(summary.finishedDate);
  const durationKnown =
    summary.startedDate != null &&
    summary.durationDays != null &&
    summary.durationDays > 0;
  const pagesKnown = summary.pages != null && summary.pages > 0;
  const rating =
    summary.rating != null && summary.rating >= 1 && summary.rating <= 10
      ? summary.rating / 2
      : null;

  return {
    title: summary.book.title.trim() || 'Untitled',
    authors: formatAuthors(summary.book.authors),
    eyebrow: finished
      ? `Finished · ${MONTHS_LONG[finished.month - 1]} ${finished.year}`
      : 'Finished',
    monthLabel: finished
      ? `${shortMonth(finished.month)} ${finished.year}`
      : null,
    dateRange:
      toggles.duration && finished
        ? formatDateRange(
            durationKnown ? summary.startedDate : null,
            summary.finishedDate,
          )
        : null,
    yearOrdinal:
      toggles.duration &&
      summary.yearFinishOrdinal != null &&
      summary.finishYear != null
        ? `Book ${summary.yearFinishOrdinal} of ${summary.finishYear}`
        : null,
    durationDays:
      toggles.duration && durationKnown ? summary.durationDays : null,
    pages: toggles.pages && pagesKnown ? summary.pages : null,
    pagesPerDay:
      toggles.pages &&
      pagesKnown &&
      durationKnown &&
      summary.pagesPerDay != null
        ? summary.pagesPerDay
        : null,
    stars: toggles.rating ? rating : null,
    chart: toggles.chart && durationKnown ? buildShareCardChart(summary) : null,
    showLogo: toggles.logo,
  };
}

/** The stats a card can show, in display order. */
export function shareCardStats(model: ShareCardModel): ShareCardStat[] {
  const stats: ShareCardStat[] = [];
  if (model.durationDays != null) {
    stats.push({
      key: 'days',
      value: formatCount(model.durationDays),
      unit: model.durationDays === 1 ? 'day' : 'days',
      label: model.durationDays === 1 ? 'day' : 'days',
    });
  }
  if (model.pages != null) {
    stats.push({
      key: 'pages',
      value: formatCount(model.pages),
      unit: 'pages',
      label: 'pages',
    });
  }
  if (model.pagesPerDay != null) {
    stats.push({
      key: 'pace',
      value: formatPace(model.pagesPerDay),
      unit: '/day',
      label: 'pages / day',
    });
  }
  if (model.stars != null) {
    stats.push({
      key: 'rating',
      value: formatStars(model.stars),
      unit: '★',
      label: 'rating',
    });
  }
  return stats;
}

/** Which toggles have data behind them for this summary. */
export function availableShareCardToggles(
  summary: FinishSummary,
): ShareCardToggles {
  const durationKnown =
    summary.startedDate != null &&
    summary.durationDays != null &&
    summary.durationDays > 0;
  return {
    rating: summary.rating != null && summary.rating > 0,
    duration: summary.finishedDate != null,
    pages: summary.pages != null && summary.pages > 0,
    chart: durationKnown && buildShareCardChart(summary) != null,
    logo: true,
  };
}

/** A file name such as "delb-the-glass-observatory-square.png". */
export function shareCardFileName(
  title: string,
  format: ShareCardFormat,
): string {
  const slug =
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'book';
  return `delb-${slug}-${format}.png`;
}
