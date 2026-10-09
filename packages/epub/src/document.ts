import { readArchive } from './archive.js';
import { invalidEpub } from './errors.js';
import { archiveDirname, resolveHref } from './path.js';
import type { CoverInspection, EpubReadOptions } from './types.js';
import { childElement, elements, parseXml } from './xml.js';

export interface ManifestItem {
  element: Element;
  id: string;
  href: string;
  path: string;
  mediaType: string;
  properties: string[];
}

export interface EpubDocument {
  files: Map<string, Uint8Array>;
  containerDocument: Document;
  opfDocument: Document;
  opfPath: string;
  rootDir: string;
  version: 2 | 3;
  packageElement: Element;
  metadataElement: Element;
  manifestElement: Element;
  spineElement: Element;
}

export function readEpub(
  input: Uint8Array,
  options?: EpubReadOptions,
): EpubDocument {
  const files = readArchive(input, options?.limits);
  const mimetype = files.get('mimetype');
  if (
    !mimetype ||
    new TextDecoder().decode(mimetype) !== 'application/epub+zip'
  ) {
    throw invalidEpub('EPUB mimetype is missing or invalid');
  }
  const containerBytes = files.get('META-INF/container.xml');
  if (!containerBytes) throw invalidEpub('META-INF/container.xml is missing');
  const containerDocument = parseXml(containerBytes, 'META-INF/container.xml');
  const rootfiles = elements(containerDocument, 'rootfile');
  const rootfile =
    rootfiles.find(
      (item) =>
        item.getAttribute('media-type') === 'application/oebps-package+xml',
    ) ?? rootfiles.find((item) => item.hasAttribute('full-path'));
  const declaredPath = rootfile?.getAttribute('full-path');
  if (!declaredPath)
    throw invalidEpub('EPUB container does not declare an OPF rootfile');
  const opfPath = resolveHref('root', declaredPath);
  const opfBytes = files.get(opfPath);
  if (!opfBytes)
    throw invalidEpub(`Declared OPF rootfile is missing: ${opfPath}`);
  const opfDocument = parseXml(opfBytes, opfPath);
  const packageElement = opfDocument.documentElement;
  if (
    !packageElement ||
    (packageElement.localName ?? packageElement.nodeName) !== 'package'
  ) {
    throw invalidEpub('OPF document does not have a package root element');
  }
  const metadataElement = childElement(packageElement, 'metadata');
  const manifestElement = childElement(packageElement, 'manifest');
  const spineElement = childElement(packageElement, 'spine');
  if (!metadataElement || !manifestElement || !spineElement) {
    throw invalidEpub(
      'OPF document must contain metadata, manifest, and spine elements',
    );
  }
  const rawVersion = packageElement.getAttribute('version') ?? '';
  const version = rawVersion.startsWith('2')
    ? 2
    : rawVersion.startsWith('3')
      ? 3
      : undefined;
  if (!version)
    throw invalidEpub(
      `Unsupported EPUB package version: ${rawVersion || '<missing>'}`,
    );
  return {
    files,
    containerDocument,
    opfDocument,
    opfPath,
    rootDir: archiveDirname(opfPath),
    version,
    packageElement,
    metadataElement,
    manifestElement,
    spineElement,
  };
}

export function manifestItems(epub: EpubDocument): ManifestItem[] {
  return elements(epub.manifestElement, 'item').map((element) => {
    const id = element.getAttribute('id') ?? '';
    const href = element.getAttribute('href') ?? '';
    return {
      element,
      id,
      href,
      path: resolveHref(epub.opfPath, href),
      mediaType:
        element.getAttribute('media-type') ?? 'application/octet-stream',
      properties: (element.getAttribute('properties') ?? '')
        .split(/\s+/)
        .filter(Boolean),
    };
  });
}

export function isImage(item: ManifestItem | undefined): boolean {
  return Boolean(item?.mediaType.startsWith('image/'));
}

export function spinePaths(
  epub: EpubDocument,
): Array<{ itemref: Element; item?: ManifestItem }> {
  const byId = new Map(manifestItems(epub).map((item) => [item.id, item]));
  return elements(epub.spineElement, 'itemref').map((itemref) => ({
    itemref,
    item: byId.get(itemref.getAttribute('idref') ?? ''),
  }));
}

export function simpleCoverImagePath(
  epub: EpubDocument,
  pagePath: string,
): string | undefined {
  const bytes = epub.files.get(pagePath);
  if (!bytes) return undefined;
  let document: Document;
  try {
    document = parseXml(bytes, pagePath);
  } catch {
    return undefined;
  }
  const body = elements(document, 'body')[0] ?? document.documentElement;
  const images = [...elements(body, 'img'), ...elements(body, 'image')];
  if (images.length !== 1 || (body.textContent ?? '').replace(/\s+/g, ''))
    return undefined;
  const href =
    images[0]!.getAttribute('src') ||
    images[0]!.getAttribute('href') ||
    images[0]!.getAttribute('xlink:href');
  return href ? resolveHref(pagePath, href) : undefined;
}

export function inspectDocumentCover(
  epub: EpubDocument,
): CoverInspection | undefined {
  const manifest = manifestItems(epub);
  const byId = new Map(manifest.map((item) => [item.id, item]));
  const make = (
    item: ManifestItem | undefined,
    source: CoverInspection['source'],
    titlePagePath?: string,
  ): CoverInspection | undefined => {
    if (!item || !isImage(item)) return undefined;
    const data = epub.files.get(item.path);
    if (!data) return undefined;
    return {
      epubVersion: epub.version,
      imagePath: item.path,
      imageId: item.id,
      mediaType: item.mediaType,
      titlePagePath,
      source,
      imageData: data,
    };
  };

  if (epub.version === 3) {
    const marked = manifest.find((item) =>
      item.properties.includes('cover-image'),
    );
    const result = make(marked, 'epub3-property', findTitlePage(epub));
    if (result) return result;
  }

  for (const meta of elements(epub.metadataElement, 'meta')) {
    if (meta.getAttribute('name') !== 'cover') continue;
    const result = make(
      byId.get(meta.getAttribute('content') ?? ''),
      'epub2-meta',
      findTitlePage(epub),
    );
    if (result) return result;
  }

  for (const reference of elements(epub.packageElement, 'reference')) {
    if ((reference.getAttribute('type') ?? '').toLowerCase() !== 'cover')
      continue;
    const href = reference.getAttribute('href');
    if (!href) continue;
    const targetPath = resolveHref(epub.opfPath, href);
    const direct = manifest.find((item) => item.path === targetPath);
    const directResult = make(direct, 'guide');
    if (directResult) return directResult;
    const imagePath = simpleCoverImagePath(epub, targetPath);
    const wrapped = manifest.find((item) => item.path === imagePath);
    const wrappedResult = make(wrapped, 'guide', targetPath);
    if (wrappedResult) return wrappedResult;
  }

  const first = spinePaths(epub)[0]?.item;
  if (first) {
    const imagePath = isImage(first)
      ? first.path
      : simpleCoverImagePath(epub, first.path);
    const item = manifest.find((candidate) => candidate.path === imagePath);
    const result = make(
      item,
      'first-spine',
      isImage(first) ? undefined : first.path,
    );
    if (result) return result;
  }
  return undefined;
}

function findTitlePage(epub: EpubDocument): string | undefined {
  const manifest = manifestItems(epub);
  const marked = manifest.find((item) =>
    item.properties.includes('calibre:title-page'),
  );
  if (marked) return marked.path;
  for (const reference of elements(epub.packageElement, 'reference')) {
    if ((reference.getAttribute('type') ?? '').toLowerCase() !== 'cover')
      continue;
    const href = reference.getAttribute('href');
    if (!href) continue;
    const path = resolveHref(epub.opfPath, href);
    if (
      manifest.find((item) => item.path === path)?.mediaType ===
      'application/xhtml+xml'
    )
      return path;
  }
  return undefined;
}

export function isPathEncrypted(epub: EpubDocument, path: string): boolean {
  const encryption = epub.files.get('META-INF/encryption.xml');
  if (!encryption) return false;
  const document = parseXml(encryption, 'META-INF/encryption.xml');
  for (const reference of elements(document, 'CipherReference')) {
    const uri = reference.getAttribute('URI');
    if (uri && resolveHref('root', uri) === path) return true;
  }
  return false;
}
