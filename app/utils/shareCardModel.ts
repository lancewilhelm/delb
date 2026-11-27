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

/** Response data of `GET /api/books/{id}/finish-summary`, optionally enriched
 *  on the client with status-specific details (DNF date, TBR rank, live progress). */
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
  dnfDate?: string | null;
  tbrRank?: number | null;
  currentProgressPercent?: number | null;
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
  progress?: boolean;
  chart: boolean;
  logo: boolean;
};

export const DEFAULT_SHARE_CARD_TOGGLES: ShareCardToggles = {
  rating: true,
  duration: true,
  pages: true,
  progress: true,
  chart: true,
  logo: true,
};

/** The fewest dated checkpoints that make a pace chart worth drawing. */
export const MIN_CHART_CHECKPOINTS = 3;

export type ShareCardStat = {
  key: 'days' | 'pages' | 'pace' | 'rating' | 'progress';
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
  status: FinishSummary['status'];
  title: string;
  authors: string;
  /** Status-aware eyebrow, e.g. "Finished · November 2026" or "Currently Reading". */
  eyebrow: string;
  /** Uppercase banner for Swiss Grid header, e.g. "FINISHED READING" or "CURRENTLY READING". */
  statusBanner: string;
  /** Caption above duration hero stat in Editorial Split (e.g. "Start to finish" or "Reading so far"). */
  durationCaption: string;
  /** Caption above duration number in Pace Overlay (e.g. "Finished in" or "Reading for"). */
  durationOverlayCaption: string;
  /** Caption above pages number in Pace Overlay (e.g. "Read" or "Length"). */
  pagesOverlayCaption: string;
  /** Short badge/month label, e.g. "Nov 2026", "TBR #3", or null. */
  monthLabel: string | null;
  /** "Nov 3 – Nov 11, 2026" or "Started Nov 3, 2026", or null. */
  dateRange: string | null;
  /** "Book 12 of 2026", or null. */
  yearOrdinal: string | null;
  durationDays: number | null;
  pages: number | null;
  pagesPerDay: number | null;
  /** Latest reading progress percent (0..100) for in-progress / DNF books, or null. */
  progressPercent: number | null;
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

function localTodayYmd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function inclusiveDaySpanYmd(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (!s || !e) return null;
  const startUtc = Date.UTC(s.year, s.month - 1, s.day);
  const endUtc = Date.UTC(e.year, e.month - 1, e.day);
  if (endUtc < startUtc) return null;
  return Math.round((endUtc - startUtc) / 86_400_000) + 1;
}

/**
 * Builds a daily progress series on the client from `/api/books/{id}/progress`
 * history entries for in-progress (`reading`) or `dnf` books.
 */
export function buildProgressSeriesFromHistory(
  entries: { occurredDate: string; progressPercent: number }[],
  pages: number | null,
  startDate?: string | null,
  endDate?: string | null,
): FinishSummary['progress'] {
  const valid = entries.filter((e) => parseYmd(e.occurredDate) != null);
  if (!valid.length) return { checkpointCount: 0, days: [] };

  const best = new Map<string, number>();
  for (const e of valid) {
    const pct = Math.max(0, Math.min(100, e.progressPercent));
    const prev = best.get(e.occurredDate);
    if (prev == null || pct > prev) best.set(e.occurredDate, pct);
  }
  const sortedDates = Array.from(best.keys()).sort();
  const firstDate =
    startDate && parseYmd(startDate) && startDate <= sortedDates[0]!
      ? startDate
      : sortedDates[0]!;
  const lastLogDate = sortedDates[sortedDates.length - 1]!;
  const lastDate =
    endDate && parseYmd(endDate) && endDate >= lastLogDate
      ? endDate
      : lastLogDate;

  const span = inclusiveDaySpanYmd(firstDate, lastDate);
  if (!span || span <= 0 || span > 3660) {
    return { checkpointCount: 0, days: [] };
  }

  const startParts = parseYmd(firstDate)!;
  const startUtc = Date.UTC(
    startParts.year,
    startParts.month - 1,
    startParts.day,
  );
  const days: FinishProgressDay[] = [];
  let cumulative = 0;
  let prevPages = 0;
  for (let i = 0; i < span; i++) {
    const d = new Date(startUtc + i * 86_400_000);
    const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const pct = best.get(ymd);
    const hasCheckpoint = pct != null;
    const before = cumulative;
    if (hasCheckpoint && pct > cumulative) cumulative = pct;
    const curPages =
      pages != null && pages > 0
        ? Math.round((cumulative / 100) * pages)
        : null;
    const pagesRead = curPages != null ? curPages - prevPages : null;
    if (curPages != null) prevPages = curPages;
    days.push({
      date: ymd,
      percent: Math.round(cumulative * 100) / 100,
      deltaPercent: Math.round((cumulative - before) * 100) / 100,
      pages: curPages,
      pagesRead,
      hasCheckpoint,
    });
  }
  return { checkpointCount: best.size, days };
}

function effectiveDurationDays(
  summary: FinishSummary,
  todayYmd: string,
): number | null {
  if (summary.status === 'finished') {
    return summary.startedDate != null &&
      summary.durationDays != null &&
      summary.durationDays > 0
      ? summary.durationDays
      : null;
  }
  if (summary.status === 'reading') {
    if (!summary.startedDate) return null;
    return inclusiveDaySpanYmd(summary.startedDate, todayYmd);
  }
  if (summary.status === 'dnf') {
    if (!summary.startedDate || !summary.dnfDate) return null;
    return inclusiveDaySpanYmd(summary.startedDate, summary.dnfDate);
  }
  return null;
}

function effectiveProgressPercent(summary: FinishSummary): number | null {
  if (summary.status !== 'reading' && summary.status !== 'dnf') return null;
  const pct = summary.currentProgressPercent;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) return null;
  return Math.min(100, Math.round(pct));
}

export function buildShareCardModel(
  summary: FinishSummary,
  toggles: ShareCardToggles,
  todayYmd = localTodayYmd(),
): ShareCardModel {
  const status = summary.status;
  const finished = parseYmd(summary.finishedDate);
  const started = parseYmd(summary.startedDate);
  const dnf = parseYmd(summary.dnfDate);
  const durationDays = effectiveDurationDays(summary, todayYmd);
  const durationKnown = durationDays != null && durationDays > 0;
  const pagesKnown = summary.pages != null && summary.pages > 0;
  const progressPct = effectiveProgressPercent(summary);
  const rating =
    summary.rating != null && summary.rating >= 1 && summary.rating <= 10
      ? summary.rating / 2
      : null;
  const tbrRank =
    typeof summary.tbrRank === 'number' &&
    Number.isFinite(summary.tbrRank) &&
    summary.tbrRank > 0
      ? Math.round(summary.tbrRank)
      : null;

  let eyebrow = 'From My Library';
  let statusBanner = 'FROM MY LIBRARY';
  let monthLabel: string | null = null;
  let dateRange: string | null = null;
  let yearOrdinal: string | null = null;
  let durationCaption = 'Start to finish';
  let durationOverlayCaption = 'Finished in';
  let pagesOverlayCaption = 'Length';

  if (status === 'finished') {
    eyebrow = finished
      ? `Finished · ${MONTHS_LONG[finished.month - 1]} ${finished.year}`
      : 'Finished';
    statusBanner = 'FINISHED READING';
    monthLabel = finished
      ? `${shortMonth(finished.month)} ${finished.year}`
      : null;
    dateRange =
      toggles.duration && finished
        ? formatDateRange(
            durationKnown ? summary.startedDate : null,
            summary.finishedDate,
          )
        : null;
    yearOrdinal =
      toggles.duration &&
      summary.yearFinishOrdinal != null &&
      summary.finishYear != null
        ? `Book ${summary.yearFinishOrdinal} of ${summary.finishYear}`
        : null;
    durationCaption = 'Start to finish';
    durationOverlayCaption = 'Finished in';
    pagesOverlayCaption = 'Read';
  } else if (status === 'reading') {
    eyebrow = started
      ? `Currently Reading · ${MONTHS_LONG[started.month - 1]} ${started.year}`
      : 'Currently Reading';
    statusBanner = 'CURRENTLY READING';
    monthLabel = started
      ? `Started ${shortMonth(started.month)} ${started.year}`
      : null;
    dateRange =
      toggles.duration && started
        ? `Started ${shortMonth(started.month)} ${started.day}, ${started.year}`
        : null;
    durationCaption = 'Reading so far';
    durationOverlayCaption = 'Reading for';
    pagesOverlayCaption = 'Length';
  } else if (status === 'to_be_read') {
    eyebrow = tbrRank != null ? `To Be Read · #${tbrRank}` : 'To Be Read';
    statusBanner = 'TO BE READ';
    monthLabel = tbrRank != null ? `TBR #${tbrRank}` : null;
    pagesOverlayCaption = 'Length';
  } else if (status === 'dnf') {
    eyebrow = dnf
      ? `Did Not Finish · ${MONTHS_LONG[dnf.month - 1]} ${dnf.year}`
      : 'Did Not Finish';
    statusBanner = 'DID NOT FINISH';
    monthLabel = dnf ? `${shortMonth(dnf.month)} ${dnf.year}` : null;
    if (toggles.duration) {
      if (dnf) {
        dateRange = formatDateRange(
          durationKnown ? summary.startedDate : null,
          summary.dnfDate,
        );
      } else if (started) {
        dateRange = `Started ${shortMonth(started.month)} ${started.day}, ${started.year}`;
      }
    }
    durationCaption = 'Reading span';
    durationOverlayCaption = 'Read for';
    pagesOverlayCaption = 'Length';
  }

  const canHaveChart =
    status === 'finished'
      ? durationKnown
      : status === 'reading' || status === 'dnf';
  const showProgress = toggles.progress !== false;

  return {
    status,
    title: summary.book.title.trim() || 'Untitled',
    authors: formatAuthors(summary.book.authors),
    eyebrow,
    statusBanner,
    durationCaption,
    durationOverlayCaption,
    pagesOverlayCaption,
    monthLabel,
    dateRange,
    yearOrdinal,
    durationDays: toggles.duration && durationKnown ? durationDays : null,
    pages: toggles.pages && pagesKnown ? summary.pages : null,
    pagesPerDay:
      status === 'finished' &&
      toggles.pages &&
      pagesKnown &&
      durationKnown &&
      summary.pagesPerDay != null
        ? summary.pagesPerDay
        : null,
    progressPercent: showProgress ? progressPct : null,
    stars: toggles.rating ? rating : null,
    chart: toggles.chart && canHaveChart ? buildShareCardChart(summary) : null,
    showLogo: toggles.logo,
  };
}

/** The stats a card can show, in display order. */
export function shareCardStats(model: ShareCardModel): ShareCardStat[] {
  const stats: ShareCardStat[] = [];
  if (model.progressPercent != null) {
    stats.push({
      key: 'progress',
      value: `${Math.round(model.progressPercent)}`,
      unit: '%',
      label: model.status === 'dnf' ? 'reached' : 'progress',
    });
  }
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
  todayYmd = localTodayYmd(),
): ShareCardToggles {
  const durationDays = effectiveDurationDays(summary, todayYmd);
  const durationKnown = durationDays != null && durationDays > 0;
  const status = summary.status;

  const hasDateInfo =
    status === 'finished'
      ? summary.finishedDate != null
      : status === 'reading'
        ? summary.startedDate != null
        : status === 'dnf'
          ? summary.dnfDate != null || summary.startedDate != null
          : false;

  const canHaveChart =
    status === 'finished'
      ? durationKnown
      : status === 'reading' || status === 'dnf';

  return {
    rating: summary.rating != null && summary.rating > 0,
    duration: hasDateInfo,
    pages: summary.pages != null && summary.pages > 0,
    progress: effectiveProgressPercent(summary) != null,
    chart: canHaveChart && buildShareCardChart(summary) != null,
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
