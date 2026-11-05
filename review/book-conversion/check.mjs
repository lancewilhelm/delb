import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { directory, setup, sha256 } from './setup.mjs';
import { convert, parseDocument, bodyText, normalize } from './convert.mjs';

await setup();
const originalParser = process.argv.includes('--original-parser');
const output = path.join(
  directory,
  'output',
  originalParser ? 'original-parser' : '.',
);
await mkdir(output, { recursive: true });
const cover = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWLsAAAAASUVORK5CYII=',
  'base64',
);
const metadata = {
  title: 'Delb conversion feasibility',
  authors: ['Delb metadata author'],
  language: 'en',
  cover,
};
const positive = [
  'alice.mobi',
  'alice.azw3',
  'sample-cp1252.mobi',
  'sample-unicode-huffdic.mobi',
  'sample-unicode-uncompressed.mobi',
  'sample-ncx.mobi',
  'sample-obfuscated-fonts.mobi',
];
const diagnostic = ['sample-multimedia.mobi'];
const report = {
  purpose: 'Feasibility only; not application or visual-reader verification',
  parser: originalParser
    ? 'unmodified Foliate'
    : 'Foliate with explicit KF8 insertion-target fallback',
  metadata: {
    title: metadata.title,
    authors: metadata.authors,
    language: metadata.language,
  },
  samples: [],
};

function spineDocuments(files) {
  const container = new DOMParser().parseFromString(
    strFromU8(files['META-INF/container.xml']),
    'application/xml',
  );
  const filename = container
    .getElementsByTagNameNS('*', 'rootfile')[0]
    .getAttribute('full-path');
  const opf = new DOMParser().parseFromString(
    strFromU8(files[filename]),
    'application/xml',
  );
  const items = new Map(
    Array.from(opf.getElementsByTagNameNS('*', 'item'), (item) => [
      item.getAttribute('id'),
      item.getAttribute('href'),
    ]),
  );
  return Array.from(opf.getElementsByTagNameNS('*', 'itemref'), (item) => {
    const target = path.posix.join(
      path.posix.dirname(filename),
      items.get(item.getAttribute('idref')),
    );
    return parseDocument(strFromU8(files[target]));
  });
}

function inspect(bytes, facts) {
  bytes = Buffer.from(bytes);
  const files = unzipSync(bytes);
  const errors = [];
  const opf = parseDocument(strFromU8(files['OEBPS/package.opf']));
  if (opf.querySelector('parsererror')) errors.push('Invalid OPF XML');
  const texts = new Map();
  const docs = new Map();
  for (const [filename, data] of Object.entries(files)) {
    if (!/\.(xhtml|svg|css)$/.test(filename)) continue;
    const text = strFromU8(data);
    if (/blob:nodedata:|kindle:(?:flow|embed|pos):|filepos:/i.test(text))
      errors.push(`Unresolved source URI in ${filename}`);
    texts.set(filename, text);
    if (!/\.(xhtml|svg)$/.test(filename)) continue;
    const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (doc.querySelector('parsererror'))
      errors.push(`Invalid XML in ${filename}`);
    docs.set(filename, doc);
  }
  function reference(filename, href) {
    if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return;
    const [pathname, fragment] = href.split('#');
    const target = pathname
      ? path.posix.normalize(
          path.posix.join(
            path.posix.dirname(filename),
            decodeURIComponent(pathname),
          ),
        )
      : filename;
    if (!files[target]) errors.push(`Missing resource ${filename} -> ${href}`);
    else if (
      fragment &&
      docs.has(target) &&
      !docs.get(target).getElementById(decodeURIComponent(fragment))
    )
      errors.push(`Missing anchor ${filename} -> ${href}`);
  }
  for (const [filename, doc] of docs) {
    const ids = new Set();
    for (const element of doc.querySelectorAll('[id]')) {
      if (ids.has(element.id))
        errors.push(`Duplicate ID in ${filename}: ${element.id}`);
      ids.add(element.id);
    }
    for (const element of doc.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        if (['href', 'src', 'poster', 'xlink:href'].includes(attribute.name))
          reference(filename, attribute.value);
      }
    }
  }
  for (const [filename, text] of texts) {
    for (const match of text.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g))
      reference(filename, match[1]);
  }
  for (const item of opf.getElementsByTagName('item'))
    reference('OEBPS/package.opf', item.getAttribute('href'));
  const markerName = bytes.subarray(30, 38).toString();
  if (
    markerName !== 'mimetype' ||
    bytes.readUInt16LE(8) !== 0 ||
    bytes.readUInt16LE(28) !== 0 ||
    strFromU8(files.mimetype) !== 'application/epub+zip'
  )
    errors.push('Invalid first uncompressed mimetype entry');
  for (const check of facts.textChecks)
    if (!check.unchanged)
      errors.push(`Body text changed in section ${check.section}`);
  for (const asset of facts.assets) {
    if (
      !['text/css', 'image/svg+xml', 'application/xhtml+xml'].includes(
        asset.type,
      ) &&
      sha256(files[`OEBPS/${asset.filename}`]) !== asset.sourceHash
    )
      errors.push(`Binary asset changed: ${asset.filename}`);
  }
  if (opf.getElementsByTagName('dc:title')[0]?.textContent !== metadata.title)
    errors.push('Catalog title not embedded');
  if (
    opf.getElementsByTagName('dc:creator')[0]?.textContent !==
    metadata.authors[0]
  )
    errors.push('Catalog author not embedded');
  if (sha256(files['OEBPS/cover.png']) !== sha256(cover))
    errors.push('Catalog cover not embedded');
  const navLinks = docs.get('OEBPS/nav.xhtml')?.querySelectorAll('nav a') ?? [];
  if (
    facts.navigation === 'source' &&
    navLinks.length !== facts.sourceTOCEntries
  )
    errors.push('TOC entry count changed');
  if (Array.from(navLinks).some((a) => !a.textContent.trim()))
    errors.push('Empty TOC labels');
  return { errors, files, docs, navEntries: navLinks.length };
}

const referenceFiles = unzipSync(
  await readFile(path.join(directory, '.cache/fixtures/alice-reference.epub')),
);
const referenceParagraphs = spineDocuments(referenceFiles)
  .flatMap((doc) =>
    Array.from(doc.querySelectorAll('.chapter p'), (p) =>
      normalize(p.textContent),
    ),
  )
  .filter((text) => text.length > 20);
if (!referenceParagraphs.length)
  throw new Error('Independent Alice reference chapters were not found');

for (const name of [...positive, ...diagnostic]) {
  const filename = path.join(directory, '.cache/fixtures', name);
  const before = await readFile(filename);
  try {
    const result = await convert(before, name, metadata, { originalParser });
    const validation = inspect(result.epub, result.facts);
    const after = await readFile(filename);
    if (!before.equals(after)) validation.errors.push('Source file changed');
    let independentReference;
    if (name.startsWith('alice.')) {
      const text = spineDocuments(validation.files).map(bodyText).join(' ');
      let cursor = 0;
      const missing = referenceParagraphs.filter((paragraph) => {
        const index = text.indexOf(paragraph, cursor);
        if (index < 0) return true;
        cursor = index + paragraph.length;
        return false;
      });
      independentReference = {
        paragraphs: referenceParagraphs.length,
        matchedInOrder: referenceParagraphs.length - missing.length,
        missingExamples: missing.slice(0, 3),
      };
      if (missing.length)
        validation.errors.push(
          `${missing.length} independent reference paragraphs unmatched`,
        );
    }
    const outputName = `${name}.epub`;
    await writeFile(path.join(output, outputName), result.epub);
    const entry = {
      name,
      diagnostic: diagnostic.includes(name),
      output: outputName,
      sourceHash: sha256(before),
      outputHash: sha256(result.epub),
      ...result.facts,
      navEntries: validation.navEntries,
      independentReference,
      errors: validation.errors,
      result: validation.errors.length
        ? 'needs-work'
        : 'structural-checks-passed',
    };
    report.samples.push(entry);
    console.log(
      `${name}: ${entry.result}; ${result.facts.sections} sections, ${validation.navEntries} TOC entries, ${result.facts.assets.length} assets`,
    );
    if (validation.errors.length)
      console.log(validation.errors.slice(0, 8).join('\n'));
  } catch (error) {
    report.samples.push({
      name,
      diagnostic: diagnostic.includes(name),
      result: 'conversion-failed',
      error: error.stack,
    });
    console.log(`${name}: conversion-failed: ${error.message}`);
  }
}
for (const name of ['sample-drm-v1.mobi', 'sample-drm_pidLTKULBB^5V-v2.mobi']) {
  const protectedBytes = await readFile(
    path.join(directory, '.cache/fixtures', name),
  );
  try {
    await convert(protectedBytes, name, metadata, { originalParser });
    report.samples.push({
      name,
      result: 'protected-input-incorrectly-accepted',
    });
  } catch (error) {
    report.samples.push({
      name,
      result:
        error.message === 'Protected input is unsupported'
          ? 'protected-input-rejected'
          : 'unexpected-rejection',
      message: error.message,
    });
  }
}
await writeFile(
  path.join(output, 'report.json'),
  `${JSON.stringify(report, (key, value) => (key === 'cover' ? undefined : value), 2)}\n`,
);
const failed = report.samples.filter(
  (sample) =>
    !sample.diagnostic &&
    !['structural-checks-passed', 'protected-input-rejected'].includes(
      sample.result,
    ),
);
console.log(
  `Report: ${path.relative(directory, path.join(output, 'report.json'))}. Required samples with gaps: ${failed.length}. EPUBCheck is a separate check.`,
);
if (failed.length) process.exitCode = 1;
