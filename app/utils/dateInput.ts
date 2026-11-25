/**
 * Whether a date input value is a complete, plausible date (YYYY-MM-DD with a
 * four-digit year of at least 1000). While a reader types a year, browsers
 * report intermediate values such as 0002-05-14, which are not plausible.
 */
export function isCompleteDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}
