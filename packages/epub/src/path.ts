import { invalidEpub } from './errors.js';

export function normalizeArchivePath(input: string): string {
  if (
    !input ||
    input.includes('\\') ||
    input.startsWith('/') ||
    /^[a-z]:/i.test(input)
  ) {
    throw invalidEpub(`Unsafe EPUB archive path: ${input || '<empty>'}`);
  }
  const parts: string[] = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length)
        throw invalidEpub(`EPUB path escapes the archive root: ${input}`);
      parts.pop();
      continue;
    }
    if (part.includes('\0'))
      throw invalidEpub('EPUB paths cannot contain NUL bytes');
    parts.push(part);
  }
  if (!parts.length) throw invalidEpub(`Unsafe EPUB archive path: ${input}`);
  return parts.join('/');
}

export function archiveDirname(input: string): string {
  const index = input.lastIndexOf('/');
  return index < 0 ? '' : input.slice(0, index);
}

export function archiveBasename(input: string): string {
  const index = input.lastIndexOf('/');
  return index < 0 ? input : input.slice(index + 1);
}

export function archiveJoin(...parts: string[]): string {
  return normalizeArchivePath(parts.filter(Boolean).join('/'));
}

export function resolveHref(baseFile: string, href: string): string {
  const raw = href.split('#', 1)[0]?.split('?', 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = raw
      .split('/')
      .map((part) => decodeURIComponent(part))
      .join('/');
  } catch (cause) {
    throw invalidEpub(`Invalid percent-encoding in EPUB href: ${href}`, cause);
  }
  return archiveJoin(archiveDirname(baseFile), decoded);
}

export function relativeHref(fromFile: string, targetFile: string): string {
  const from = archiveDirname(fromFile).split('/').filter(Boolean);
  const target = targetFile.split('/').filter(Boolean);
  let common = 0;
  while (
    common < from.length &&
    common < target.length &&
    from[common] === target[common]
  )
    common += 1;
  const value = [...from.slice(common).map(() => '..'), ...target.slice(common)]
    .map((part) => encodeURIComponent(part).replace(/%2F/gi, '/'))
    .join('/');
  return value || archiveBasename(targetFile);
}

export function uniqueArchivePath(
  files: Map<string, Uint8Array>,
  preferred: string,
): string {
  if (!files.has(preferred)) return preferred;
  const dot = preferred.lastIndexOf('.');
  const stem = dot >= 0 ? preferred.slice(0, dot) : preferred;
  const extension = dot >= 0 ? preferred.slice(dot) : '';
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!files.has(candidate)) return candidate;
  }
}
