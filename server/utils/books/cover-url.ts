export type CoverUrlVariant = 'thumb' | 'source';

export function buildBookCoverUrl(opts: {
  bookId: string;
  updatedAt?: unknown;
  variant?: CoverUrlVariant;
}): string {
  const variant = opts.variant ?? 'thumb';
  const base = `/api/books/${encodeURIComponent(opts.bookId)}/cover?variant=${variant}`;

  const ts = opts.updatedAt ? new Date(opts.updatedAt as string | number | Date).getTime() : NaN;
  if (!Number.isFinite(ts)) return base;

  return `${base}&v=${encodeURIComponent(String(ts))}`;
}
