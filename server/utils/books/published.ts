/**
 * Published date parsing utilities.
 *
 * Goal: normalize a variety of common "published" string formats into a real Date
 * so we can store `books.publishedAt` (timestamp) and sort correctly.
 *
 * Design notes:
 * - Many metadata sources provide partial dates (year-only, year-month).
 * - We choose a deterministic "first day" policy:
 *   - YYYY => YYYY-01-01
 *   - YYYY-MM => YYYY-MM-01
 * - We also accept full ISO date/time strings and a handful of common formats.
 * - This parser is intentionally conservative: it returns null when ambiguous.
 */
export type PublishedPrecision = 'year' | 'month' | 'day' | 'instant';

export type ParsedPublishedDate = {
  date: Date;
  precision: PublishedPrecision;
};

/**
 * Parse a raw `published` value into a normalized Date.
 *
 * Accepts:
 * - Date
 * - number (ms since epoch)
 * - strings:
 *   - YYYY
 *   - YYYY-MM
 *   - YYYY-MM-DD
 *   - ISO 8601 date/time variants (e.g. 2020-01-02T03:04:05Z)
 *   - "YYYY/MM" and "YYYY/MM/DD"
 *   - "YYYY.MM" and "YYYY.MM.DD"
 *
 * Returns null if it cannot confidently parse.
 */
export function parsePublishedDate(
  input: unknown,
): ParsedPublishedDate | null {
  if (input == null) return null;

  if (input instanceof Date) {
    const t = input.getTime();
    if (!Number.isFinite(t)) return null;
    // Treat as an instant since Date objects are fully specified.
    return { date: new Date(t), precision: 'instant' };
  }

  if (typeof input === 'number') {
    const d = new Date(input);
    if (!Number.isFinite(d.getTime())) return null;
    return { date: d, precision: 'instant' };
  }

  const raw = String(input).trim();
  if (!raw) return null;

  // Common metadata values: just a year
  // e.g. "1999"
  const mYear = raw.match(/^(\d{4})$/);
  if (mYear) {
    const y = toYear(mYear[1]!);
    if (y == null) return null;
    return {
      date: new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0)),
      precision: 'year',
    };
  }

  // Year + month (iso-ish): "YYYY-MM"
  const mYearMonthDash = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (mYearMonthDash) {
    const y = toYear(mYearMonthDash[1]!);
    const m = toMonth(mYearMonthDash[2]!);
    if (y == null || m == null) return null;
    return {
      date: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
      precision: 'month',
    };
  }

  // Year + month + day: "YYYY-MM-DD"
  const mYmdDash = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mYmdDash) {
    const y = toYear(mYmdDash[1]!);
    const m = toMonth(mYmdDash[2]!);
    const d = toDay(mYmdDash[3]!);
    if (y == null || m == null || d == null) return null;
    if (!isValidDateParts(y, m, d)) return null;
    return {
      date: new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0)),
      precision: 'day',
    };
  }

  // Slash-separated: "YYYY/MM" or "YYYY/MM/DD"
  const mSlash = raw.match(/^(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?$/);
  if (mSlash) {
    const y = toYear(mSlash[1]!);
    const m = toMonth(mSlash[2]!);
    if (y == null || m == null) return null;

    const dRaw = mSlash[3];
    if (dRaw == null) {
      return {
        date: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
        precision: 'month',
      };
    }

    const d = toDay(dRaw);
    if (d == null) return null;
    if (!isValidDateParts(y, m, d)) return null;
    return {
      date: new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0)),
      precision: 'day',
    };
  }

  // Dot-separated: "YYYY.MM" or "YYYY.MM.DD"
  const mDot = raw.match(/^(\d{4})\.(\d{1,2})(?:\.(\d{1,2}))?$/);
  if (mDot) {
    const y = toYear(mDot[1]!);
    const m = toMonth(mDot[2]!);
    if (y == null || m == null) return null;

    const dRaw = mDot[3];
    if (dRaw == null) {
      return {
        date: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
        precision: 'month',
      };
    }

    const d = toDay(dRaw);
    if (d == null) return null;
    if (!isValidDateParts(y, m, d)) return null;
    return {
      date: new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0)),
      precision: 'day',
    };
  }

  // ISO 8601 (date-time or date-only with timezone)
  // Examples:
  // - "2020-01-02T03:04:05Z"
  // - "2020-01-02T03:04:05.123+02:00"
  // - "2020-01-02" handled above
  const iso = tryParseISO(raw);
  if (iso) return iso;

  // As a last resort, attempt Date.parse but only if it looks like a date string.
  // We purposely avoid parsing arbitrary localized formats because results vary by runtime.
  if (looksDateLike(raw)) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return { date: new Date(t), precision: 'instant' };
  }

  return null;
}

/**
 * Convenience helper: parses `published` and returns a UTC Date to store as timestamp.
 */
export function normalizePublishedAt(input: unknown): Date | null {
  const parsed = parsePublishedDate(input);
  if (!parsed) return null;

  // Ensure stable storage as a Date instance.
  const t = parsed.date.getTime();
  if (!Number.isFinite(t)) return null;

  return new Date(t);
}

/**
 * Returns a normalized ISO string (UTC) for debugging/logging, or null.
 */
export function normalizePublishedAtIso(input: unknown): string | null {
  const d = normalizePublishedAt(input);
  return d ? d.toISOString() : null;
}

function toYear(s: string): number | null {
  const y = Number.parseInt(s, 10);
  if (!Number.isFinite(y)) return null;
  // Basic sanity bounds
  if (y < 0 || y > 9999) return null;
  return y;
}

function toMonth(s: string): number | null {
  const m = Number.parseInt(s, 10);
  if (!Number.isFinite(m)) return null;
  if (m < 1 || m > 12) return null;
  return m;
}

function toDay(s: string): number | null {
  const d = Number.parseInt(s, 10);
  if (!Number.isFinite(d)) return null;
  if (d < 1 || d > 31) return null;
  return d;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  // Validate by constructing and comparing parts (UTC).
  const dt = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function tryParseISO(raw: string): ParsedPublishedDate | null {
  // Basic ISO instant check: contains a 'T' and some timezone or Z, or milliseconds.
  // We don't over-validate here; Date.parse for ISO is consistent.
  const looksIsoInstant =
    /\d{4}-\d{2}-\d{2}T/.test(raw) &&
    /(Z|[+-]\d{2}:\d{2})/.test(raw);

  if (!looksIsoInstant) return null;

  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;

  return { date: new Date(t), precision: 'instant' };
}

function looksDateLike(raw: string): boolean {
  // Very lightweight guard: must contain at least one digit and a separator typical for dates.
  if (!/\d/.test(raw)) return false;
  if (raw.includes('-') || raw.includes('/') || raw.includes('.') || raw.includes('T'))
    return true;
  return false;
}
