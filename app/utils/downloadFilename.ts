export function readDownloadFilename(
  contentDisposition: string,
): string | null {
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]*)/i.exec(
    contentDisposition,
  );
  if (encoded?.[1]) {
    try {
      const filename = decodeURIComponent(encoded[1].trim());
      if (filename) return filename;
    } catch {
      // A malformed extended value must not prevent a download with a fallback.
    }
  }
  const plain =
    /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(
      contentDisposition,
    );
  return (plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2]?.trim()) || null;
}
