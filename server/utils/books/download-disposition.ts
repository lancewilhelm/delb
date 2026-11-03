export function bookDownloadDisposition(title: string, format: string): string {
  const safeTitle =
    title
      .toWellFormed()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/\p{Cc}/gu, '_')
      .trim() || 'book';
  const filename = `${safeTitle}.${format}`;
  // Keep the legacy parameter ASCII-only; filename* preserves the UTF-8 title.
  const fallback = filename.replace(/[^\x20-\x7e]|%/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
