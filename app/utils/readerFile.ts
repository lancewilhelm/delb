export type ReaderFile = { id: string; format: string | null };

export function selectReaderFile<T extends ReaderFile>(
  files: T[],
  requestedFormat?: unknown,
): T | null {
  const formats =
    requestedFormat === 'pdf' || requestedFormat === 'epub'
      ? [requestedFormat]
      : ['epub', 'pdf'];
  for (const format of formats) {
    const file = files.find(
      (file) => file.format?.trim().toLowerCase() === format,
    );
    if (file) return file;
  }
  return null;
}

export function pdfLocation(fileId: string, page: number): string {
  return `pdf:${encodeURIComponent(fileId)}:${page}`;
}

export function pdfPage(
  location: string | null | undefined,
  fileId: string,
  pageCount: number,
): number {
  const prefix = `pdf:${encodeURIComponent(fileId)}:`;
  if (!location?.startsWith(prefix)) return 1;
  const raw = location.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(raw)) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) ? Math.min(page, pageCount) : 1;
}
