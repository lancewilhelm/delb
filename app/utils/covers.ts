export type CoverVariant = 'thumb' | 'source';

export function buildBookCoverUrl(opts: {
  bookId: string;
  variant?: CoverVariant;
  updatedAt?: string | number | Date | null;
}): string {
  const variant = opts.variant ?? 'thumb';
  const base = `/api/books/${encodeURIComponent(opts.bookId)}/cover?variant=${variant}`;

  const ts = opts.updatedAt ? new Date(opts.updatedAt).getTime() : NaN;
  if (!Number.isFinite(ts)) return base;

  return `${base}&v=${encodeURIComponent(String(ts))}`;
}
