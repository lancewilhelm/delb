// Feasibility code only. No Delb database, managed storage, or job integration.
import { JSDOM } from 'jsdom';
import cssEscape from 'css.escape';
import { zipSync, strToU8, unzlibSync } from 'fflate';
import { sha256 } from './setup.mjs';

const { window } = new JSDOM('');
Object.assign(globalThis, {
  document: window.document,
  DOMParser: window.DOMParser,
  XMLSerializer: window.XMLSerializer,
  CSS: { escape: cssEscape },
});
// This approximation does not prove rendered whitespace or visual fidelity.
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() {
    return this.textContent;
  },
});

const parser = new DOMParser();
const serializer = new XMLSerializer();
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c],
  );
export const normalize = (value) => value.replace(/\s+/g, ' ').trim();
export function bodyText(doc) {
  const clone = doc.body.cloneNode(true);
  clone
    .querySelectorAll('script, style')
    .forEach((element) => element.remove());
  return normalize(clone.textContent);
}
export function parseDocument(text) {
  const doc = parser.parseFromString(text, 'application/xhtml+xml');
  return doc.querySelector('parsererror') || !doc.documentElement?.namespaceURI
    ? parser.parseFromString(text, 'text/html')
    : doc;
}
function mediaType(bytes, hint) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (bytes.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'OTTO') return 'font/otf';
  if (bytes.subarray(0, 4).toString('hex') === '00010000') return 'font/ttf';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  if (bytes.subarray(0, 3).toString() === 'ID3') return 'audio/mpeg';
  if (hint) return hint;
  return 'application/octet-stream';
}
const extensions = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'text/css': 'css',
  'font/otf': 'otf',
  'font/ttf': 'ttf',
  'application/vnd.ms-opentype': 'otf',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'application/xhtml+xml': 'xhtml',
};
const sectionName = (index) =>
  `section-${String(index).padStart(4, '0')}.xhtml`;

function normalizeLegacy(doc, title) {
  doc.doctype?.remove();
  if (!doc.head.querySelector('title'))
    doc.head.append(doc.createElement('title'));
  if (!doc.head.querySelector('title').textContent.trim())
    doc.head.querySelector('title').textContent = title;
  for (const meta of doc.querySelectorAll('meta[charset]'))
    meta.setAttribute('charset', 'utf-8');
  for (const legacy of doc.querySelectorAll('tt')) {
    const span = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
    for (const attr of Array.from(legacy.attributes))
      span.setAttribute(attr.name, attr.value);
    span.style.fontFamily = 'monospace';
    span.append(...Array.from(legacy.childNodes));
    legacy.replaceWith(span);
  }
  for (const font of doc.querySelectorAll('font')) {
    const span = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
    for (const attr of Array.from(font.attributes))
      span.setAttribute(attr.name, attr.value);
    if (font.hasAttribute('color'))
      span.style.color = font.getAttribute('color');
    if (font.hasAttribute('face'))
      span.style.fontFamily = font.getAttribute('face');
    const sizes = [
      'xx-small',
      'x-small',
      'small',
      'medium',
      'large',
      'x-large',
      'xx-large',
    ];
    if (font.hasAttribute('size')) {
      const value = font.getAttribute('size');
      const size = Number(value) + (/^[+-]/.test(value) ? 3 : 0);
      span.style.fontSize = sizes[Math.max(0, Math.min(6, size - 1))];
    }
    for (const name of ['color', 'face', 'size']) span.removeAttribute(name);
    span.append(...Array.from(font.childNodes));
    font.replaceWith(span);
  }
  for (const element of doc.querySelectorAll('*')) {
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    const mappings = {
      align: 'text-align',
      valign: 'vertical-align',
      bgcolor: 'background-color',
    };
    for (const [attribute, property] of Object.entries(mappings)) {
      if (!element.hasAttribute(attribute)) continue;
      element.style.setProperty(property, element.getAttribute(attribute));
      element.removeAttribute(attribute);
    }
    for (const dimension of ['height', 'width']) {
      if (!element.hasAttribute(dimension)) continue;
      const value = element.getAttribute(dimension);
      const property =
        element.localName === 'p'
          ? dimension === 'height'
            ? 'margin-top'
            : 'text-indent'
          : dimension;
      element.style.setProperty(
        property,
        /^\d+$/.test(value) ? `${value}px` : value,
      );
      element.removeAttribute(dimension);
    }
    if (element.hasAttribute('border')) {
      element.style.border = `${Number(element.getAttribute('border')) || 0}px solid`;
      element.removeAttribute('border');
    }
    if (
      element.hasAttribute('value') &&
      ![
        'li',
        'option',
        'input',
        'button',
        'meter',
        'progress',
        'data',
      ].includes(element.localName)
    )
      element.removeAttribute('value');
    if (element.localName === 'li' && element.parentElement?.localName !== 'ol')
      element.removeAttribute('value');
    if (element.localName === 'img' && !element.hasAttribute('alt'))
      element.setAttribute('alt', '');
    if (
      element.localName === 'a' &&
      element.hasAttribute('name') &&
      !element.id
    )
      element.id = element.getAttribute('name');
  }
}

export async function convert(
  bytes,
  name,
  metadata,
  { originalParser = false } = {},
) {
  const signature = bytes.subarray(60, 68).toString();
  if (bytes.length < 86 || !['BOOKMOBI', 'TEXtREAd'].includes(signature))
    throw new Error('Unsupported or truncated Palm database');
  const recordZero = bytes.readUInt32BE(78);
  if (recordZero + 16 > bytes.length) throw new Error('Truncated record zero');
  if (bytes.readUInt16BE(recordZero + 12) !== 0)
    throw new Error('Protected input is unsupported');
  if (signature !== 'BOOKMOBI')
    throw new Error('Legacy PalmDoc input is unsupported');

  const { MOBI } = await import(
    originalParser
      ? './.cache/foliate/mobi.js'
      : './.cache/foliate/mobi-conversion.js'
  );
  const objectURLs = new Map();
  const hints = new Map();
  const warnings = [];
  const originalCreate = URL.createObjectURL;
  const originalWarn = console.warn;
  URL.createObjectURL = (blob) => {
    const url = originalCreate.call(URL, blob);
    objectURLs.set(url, blob);
    return url;
  };
  console.warn = (...values) => warnings.push(values.map(String).join(' '));
  let book;
  try {
    book = await new MOBI({ unzlib: unzlibSync }).open(new File([bytes], name));
    book.transformTarget?.addEventListener('data', (event) => {
      const { data, type } = event.detail;
      event.detail.data = Promise.resolve(data).then((value) => {
        hints.set(
          sha256(
            typeof value === 'string' ? Buffer.from(value) : Buffer.from(value),
          ),
          type,
        );
        return value;
      });
    });
    const docs = new Map();
    const paths = new Map();
    const sourceTexts = new Map();
    for (const [index, section] of book.sections.entries()) {
      if (!section.load) continue;
      const url = await section.load();
      const doc = parseDocument(await objectURLs.get(url).text());
      docs.set(index, doc);
      paths.set(url, sectionName(index));
      sourceTexts.set(index, bodyText(doc));
    }
    if (!docs.size) throw new Error('No readable sections');

    let anchorCount = 0;
    async function resolve(href, currentIndex) {
      if (!/^(filepos:|kindle:pos:)/i.test(href)) return href;
      const target = await book.resolveHref(href);
      if (!target || !docs.has(target.index))
        throw new Error(`Unresolved internal link: ${href}`);
      const doc = docs.get(target.index);
      const anchor = target.anchor?.(doc);
      if (!anchor) throw new Error(`Missing internal link anchor: ${href}`);
      if (!anchor.id) anchor.id = `conversion-anchor-${++anchorCount}`;
      return `${target.index === currentIndex ? '' : sectionName(target.index)}#${anchor.id}`;
    }
    for (const [index, doc] of docs) {
      for (const element of doc.querySelectorAll('[href]'))
        element.setAttribute(
          'href',
          await resolve(element.getAttribute('href'), index),
        );
    }
    async function navigation(items) {
      const output = [];
      for (const item of items ?? []) {
        const href = await resolve(item.href, -1);
        output.push(
          `<li><a href="${xml(href)}">${xml(item.label)}</a>${item.subitems?.length ? await navigation(item.subitems) : ''}</li>`,
        );
      }
      return `<ol>${output.join('')}</ol>`;
    }
    const sourceTOC = book.toc?.length
      ? book.toc
      : Array.from(docs, ([index, doc]) => ({
          label:
            doc.querySelector('h1,h2,h3')?.textContent ||
            `Section ${index + 1}`,
          href: sectionName(index),
        }));
    const nav = await navigation(sourceTOC);

    const assets = [];
    for (const [url, blob] of objectURLs) {
      if (paths.has(url)) continue;
      const data = Buffer.from(await blob.arrayBuffer());
      const type = mediaType(data, hints.get(sha256(data)) || blob.type);
      const filename = `asset-${String(assets.length).padStart(4, '0')}.${extensions[type] ?? 'bin'}`;
      paths.set(url, filename);
      assets.push({ filename, type, data, sourceHash: sha256(data) });
    }
    const rewrite = (text) => {
      for (const [url, filename] of paths)
        text = text.split(url).join(filename);
      return text;
    };
    const files = {};
    const manifest = [];
    const spine = [];
    const textChecks = [];
    for (const [index, doc] of docs) {
      // MOBI guide records are navigation metadata, not reading content.
      doc
        .querySelectorAll('guide, script')
        .forEach((element) => element.remove());
      for (const element of doc.querySelectorAll('*')) {
        for (const attribute of Array.from(element.attributes)) {
          if (
            ['filepos', 'recindex', 'aid', 'mediarecindex'].includes(
              attribute.name,
            )
          )
            element.removeAttribute(attribute.name);
        }
      }
      doc.documentElement.setAttribute('lang', metadata.language);
      normalizeLegacy(doc, metadata.title);
      // These source-generator hints are superseded by the new OPF cover.
      doc
        .querySelectorAll('link[rel="coverpage"], link[rel="icon"]')
        .forEach((element) => element.remove());
      const filename = sectionName(index);
      const serialized = rewrite(serializer.serializeToString(doc));
      const outputDoc = parseDocument(serialized);
      textChecks.push({
        section: index,
        unchanged: sourceTexts.get(index) === bodyText(outputDoc),
      });
      files[`OEBPS/${filename}`] = strToU8(serialized);
      const properties = doc.querySelector('svg') ? ' properties="svg"' : '';
      manifest.push(
        `<item id="s${index}" href="${filename}" media-type="application/xhtml+xml"${properties}/>`,
      );
      spine.push(`<itemref idref="s${index}"/>`);
    }
    for (const asset of assets) {
      const textual = [
        'text/css',
        'image/svg+xml',
        'application/xhtml+xml',
      ].includes(asset.type);
      files[`OEBPS/${asset.filename}`] = textual
        ? strToU8(rewrite(asset.data.toString()))
        : asset.data;
      manifest.push(
        `<item id="a${manifest.length}" href="${asset.filename}" media-type="${asset.type}"/>`,
      );
    }
    const sourceCover = await book.getCover?.();
    const cover =
      metadata.cover ??
      (sourceCover ? Buffer.from(await sourceCover.arrayBuffer()) : null);
    if (cover) {
      const type = mediaType(cover);
      const filename = `cover.${extensions[type]}`;
      files[`OEBPS/${filename}`] = cover;
      manifest.push(
        `<item id="cover" href="${filename}" media-type="${type}" properties="cover-image"/>`,
      );
    }
    files['OEBPS/nav.xhtml'] = strToU8(
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xml(metadata.language)}"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1>${nav}</nav></body></html>`,
    );
    manifest.push(
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    );
    files['OEBPS/package.opf'] = strToU8(
      `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:sha256:${sha256(bytes)}</dc:identifier><dc:title>${xml(metadata.title)}</dc:title>${metadata.authors.map((author) => `<dc:creator>${xml(author)}</dc:creator>`).join('')}<dc:language>${xml(metadata.language)}</dc:language><meta property="dcterms:modified">2026-11-04T00:00:00Z</meta></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`,
    );
    const epub = zipSync(
      {
        mimetype: [strToU8('application/epub+zip'), { level: 0 }],
        'META-INF/container.xml': strToU8(
          '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        ),
        ...files,
      },
      { mtime: new Date(2026, 10, 4) },
    );
    return {
      epub,
      facts: {
        version: book.mobi.headers.mobi.version,
        compression: book.mobi.headers.palmdoc.compression,
        layout: book.rendition?.layout ?? 'reflowable',
        sections: docs.size,
        navigation: book.toc?.length ? 'source' : 'generated',
        sourceTOCEntries: countTOC(book.toc),
        textChecks,
        assets: assets.map(({ filename, type, sourceHash }) => ({
          filename,
          type,
          sourceHash,
        })),
        warnings,
      },
    };
  } finally {
    book?.destroy();
    for (const url of objectURLs.keys()) URL.revokeObjectURL(url);
    URL.createObjectURL = originalCreate;
    console.warn = originalWarn;
  }
}

function countTOC(items) {
  return (items ?? []).reduce(
    (total, item) => total + 1 + countTOC(item.subitems),
    0,
  );
}
