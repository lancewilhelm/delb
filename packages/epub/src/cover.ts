import { DOMParser } from '@xmldom/xmldom';
import { EpubError } from './errors.js';
import {
  inspectDocumentCover,
  isPathEncrypted,
  manifestItems,
  readEpub,
  simpleCoverImagePath,
  spinePaths,
  type EpubDocument,
  type ManifestItem,
} from './document.js';
import { archiveJoin, relativeHref, uniqueArchivePath } from './path.js';
import type {
  CoverImageInput,
  CoverInspection,
  CoverMutationOptions,
  CoverMutationResult,
  EpubReadOptions,
} from './types.js';
import {
  createOpfElement,
  elements,
  parseXml,
  serializeXml,
  XHTML_NS,
} from './xml.js';
import { writeArchive } from './archive.js';

export async function inspectCover(
  input: Uint8Array,
  options?: EpubReadOptions,
): Promise<CoverInspection | undefined> {
  return inspectDocumentCover(readEpub(input, options));
}

export async function setCover(
  input: Uint8Array,
  cover: CoverImageInput,
  options: CoverMutationOptions = {},
): Promise<CoverMutationResult> {
  return mutateCover(input, cover, false, options);
}

export async function replaceCover(
  input: Uint8Array,
  cover: CoverImageInput,
  options: CoverMutationOptions = {},
): Promise<CoverMutationResult> {
  return mutateCover(input, cover, true, options);
}

async function mutateCover(
  input: Uint8Array,
  cover: CoverImageInput,
  requireExisting: boolean,
  options: CoverMutationOptions,
): Promise<CoverMutationResult> {
  validateCoverInput(cover);
  const epub = readEpub(input, options);
  if (epub.files.has('META-INF/signatures.xml')) {
    throw new EpubError(
      'SIGNED_EPUB',
      'Signed EPUBs cannot be modified without invalidating their signatures',
    );
  }
  const existing = inspectDocumentCover(epub);
  if (requireExisting && !existing)
    throw new EpubError(
      'MISSING_COVER',
      'No existing EPUB cover could be detected',
    );
  if (existing && isPathEncrypted(epub, existing.imagePath)) {
    throw new EpubError(
      'ENCRYPTED_COVER',
      `The existing cover resource is encrypted: ${existing.imagePath}`,
    );
  }

  const warnings: string[] = [];
  const extension = cover.mediaType === 'image/png' ? 'png' : 'jpg';
  const canReuseExistingPath =
    existing &&
    ((cover.mediaType === 'image/png' &&
      existing.imagePath.toLowerCase().endsWith('.png')) ||
      (cover.mediaType === 'image/jpeg' &&
        /\.jpe?g$/i.test(existing.imagePath)));
  const preferredImagePath = archiveJoin(
    epub.rootDir,
    'images',
    `cover.${extension}`,
  );
  const imagePath = canReuseExistingPath
    ? existing.imagePath
    : uniqueArchivePath(epub.files, preferredImagePath);
  if (existing && imagePath !== existing.imagePath) {
    warnings.push(
      `Retained the previous cover resource at ${existing.imagePath} because the replacement uses a different media type.`,
    );
  }
  epub.files.set(imagePath, cover.data.slice());

  const imageItem = ensureManifestItem(
    epub,
    imagePath,
    cover.mediaType,
    existing?.imageId || 'cover-image',
  );
  normalizeCoverMarkers(epub, imageItem);

  let titlePagePath = existing?.titlePagePath;
  if (titlePagePath && simpleCoverImagePath(epub, titlePagePath)) {
    updateSimpleCoverPage(epub, titlePagePath, imagePath);
  } else {
    if (titlePagePath)
      warnings.push(
        `Preserved complex title page ${titlePagePath} and inserted a dedicated cover title page.`,
      );
    titlePagePath = uniqueArchivePath(
      epub.files,
      archiveJoin(epub.rootDir, 'titlepage.xhtml'),
    );
    epub.files.set(
      titlePagePath,
      createTitlePage(
        relativeHref(titlePagePath, imagePath),
        options.keepAspectRatio ?? true,
      ),
    );
  }
  const titleItem = ensureManifestItem(
    epub,
    titlePagePath,
    'application/xhtml+xml',
    'cover-titlepage',
  );
  normalizeTitlePage(epub, titleItem, imageItem);

  epub.files.set(epub.opfPath, serializeXml(epub.opfDocument));
  const data = writeArchive(epub.files);
  const outputCover = await inspectCover(data, options);
  if (!outputCover)
    throw new EpubError(
      'INVALID_EPUB',
      'Cover mutation completed without a detectable output cover',
    );
  const repaired =
    existing?.source === 'guide' || existing?.source === 'first-spine';
  return {
    data,
    action: existing ? (repaired ? 'repaired' : 'replaced') : 'inserted',
    cover: outputCover,
    warnings,
  };
}

function validateCoverInput(cover: CoverImageInput): void {
  if (!(cover.data instanceof Uint8Array) || cover.data.length === 0) {
    throw new EpubError(
      'UNSUPPORTED_IMAGE',
      'Cover data must be a non-empty Uint8Array',
    );
  }
  const png =
    cover.data.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => cover.data[index] === value,
    );
  const jpeg =
    cover.data.length >= 3 &&
    cover.data[0] === 0xff &&
    cover.data[1] === 0xd8 &&
    cover.data[2] === 0xff;
  if (
    (cover.mediaType === 'image/png' && !png) ||
    (cover.mediaType === 'image/jpeg' && !jpeg)
  ) {
    throw new EpubError(
      'UNSUPPORTED_IMAGE',
      `Cover bytes do not match ${cover.mediaType}`,
    );
  }
}

function ensureManifestItem(
  epub: EpubDocument,
  path: string,
  mediaType: string,
  preferredId: string,
): ManifestItem {
  const currentItems = manifestItems(epub);
  let item = currentItems.find((candidate) => candidate.path === path);
  if (!item) {
    const element = createOpfElement(epub.opfDocument, 'item');
    epub.manifestElement.appendChild(element);
    item = { element, id: '', href: '', path, mediaType, properties: [] };
  }
  const usedIds = new Set(
    currentItems
      .filter((candidate) => candidate.element !== item!.element)
      .map((candidate) => candidate.id),
  );
  let id = item.id || preferredId;
  for (let index = 2; usedIds.has(id); index += 1)
    id = `${preferredId}-${index}`;
  item.element.setAttribute('id', id);
  item.element.setAttribute('href', relativeHref(epub.opfPath, path));
  item.element.setAttribute('media-type', mediaType);
  return {
    ...item,
    id,
    href: relativeHref(epub.opfPath, path),
    mediaType,
    path,
  };
}

function normalizeCoverMarkers(
  epub: EpubDocument,
  imageItem: ManifestItem,
): void {
  for (const item of manifestItems(epub)) {
    const properties = item.properties.filter(
      (property) => property !== 'cover-image',
    );
    if (epub.version === 3 && item.element === imageItem.element)
      properties.push('cover-image');
    setProperties(item.element, properties);
  }
  for (const meta of elements(epub.metadataElement, 'meta')) {
    if (meta.getAttribute('name') === 'cover')
      epub.metadataElement.removeChild(meta);
  }
  if (epub.version === 2) {
    const meta = createOpfElement(epub.opfDocument, 'meta');
    meta.setAttribute('name', 'cover');
    meta.setAttribute('content', imageItem.id);
    epub.metadataElement.appendChild(meta);
  }
}

function normalizeTitlePage(
  epub: EpubDocument,
  titleItem: ManifestItem,
  imageItem: ManifestItem,
): void {
  for (const item of manifestItems(epub)) {
    const properties = item.properties.filter(
      (property) => property !== 'calibre:title-page',
    );
    if (epub.version === 3 && item.element === titleItem.element)
      properties.push('calibre:title-page', 'svg');
    setProperties(item.element, properties);
  }
  if (epub.version === 3) ensureCalibrePrefix(epub.packageElement);

  for (const { itemref } of spinePaths(epub)) {
    const idref = itemref.getAttribute('idref');
    if (idref === titleItem.id || idref === imageItem.id)
      epub.spineElement.removeChild(itemref);
  }
  const itemref = createOpfElement(epub.opfDocument, 'itemref');
  itemref.setAttribute('idref', titleItem.id);
  epub.spineElement.insertBefore(itemref, epub.spineElement.firstChild);

  for (const reference of elements(epub.packageElement, 'reference')) {
    if ((reference.getAttribute('type') ?? '').toLowerCase() === 'cover')
      reference.parentNode?.removeChild(reference);
  }
  if (epub.version === 2) {
    let guide = elements(epub.packageElement, 'guide')[0];
    if (!guide) {
      guide = createOpfElement(epub.opfDocument, 'guide');
      epub.packageElement.appendChild(guide);
    }
    const reference = createOpfElement(epub.opfDocument, 'reference');
    reference.setAttribute('type', 'cover');
    reference.setAttribute('title', 'Cover');
    reference.setAttribute('href', relativeHref(epub.opfPath, titleItem.path));
    guide.appendChild(reference);
  }
}

function updateSimpleCoverPage(
  epub: EpubDocument,
  pagePath: string,
  imagePath: string,
): void {
  const bytes = epub.files.get(pagePath);
  if (!bytes) return;
  const document = parseXml(bytes, pagePath);
  const image = elements(document, 'img')[0] ?? elements(document, 'image')[0];
  if (!image) return;
  const href = relativeHref(pagePath, imagePath);
  if (
    image.localName === 'image' ||
    image.nodeName.split(':').pop() === 'image'
  ) {
    if (image.hasAttribute('xlink:href'))
      image.setAttribute('xlink:href', href);
    else image.setAttribute('href', href);
  } else {
    image.setAttribute('src', href);
  }
  epub.files.set(pagePath, serializeXml(document));
}

function createTitlePage(
  imageHref: string,
  keepAspectRatio: boolean,
): Uint8Array {
  const document = new DOMParser().parseFromString(
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="${XHTML_NS}"><head><title>Cover</title><meta name="viewport" content="width=device-width,height=device-height"/></head><body style="margin:0;padding:0"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 1000 1600" preserveAspectRatio="${keepAspectRatio ? 'xMidYMid meet' : 'none'}"><image width="1000" height="1600" xlink:href="${escapeXml(imageHref)}"/></svg></body></html>`,
    'application/xml',
  );
  return serializeXml(document);
}

function setProperties(element: Element, properties: string[]): void {
  const unique = [...new Set(properties)];
  if (unique.length) element.setAttribute('properties', unique.join(' '));
  else element.removeAttribute('properties');
}

function ensureCalibrePrefix(packageElement: Element): void {
  const raw = packageElement.getAttribute('prefix') ?? '';
  if (/(^|\s)calibre\s*:/.test(raw)) return;
  packageElement.setAttribute(
    'prefix',
    `${raw.trim()} calibre: https://calibre-ebook.com`.trim(),
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
