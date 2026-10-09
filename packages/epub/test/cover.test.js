import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EpubError,
  inspectCover,
  replaceCover,
  setCover,
} from '../dist/index.js';
import { inspectCoverFile, setCoverFile } from '../dist/node.js';
import { readArchive, writeArchive } from '../dist/archive.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

test('replaces an EPUB 3 cover and produces a conforming mimetype entry', async () => {
  const input = fixture(3, { cover: true });
  const result = await replaceCover(input, {
    data: png,
    mediaType: 'image/png',
  });
  assert.equal(result.action, 'replaced');
  assert.equal(result.cover.mediaType, 'image/png');
  assert.deepEqual(result.cover.imageData, png);

  const view = new DataView(
    result.data.buffer,
    result.data.byteOffset,
    result.data.byteLength,
  );
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint16(28, true), 0);
  const nameLength = view.getUint16(26, true);
  assert.equal(
    textDecoder.decode(result.data.subarray(30, 30 + nameLength)),
    'mimetype',
  );
});

test('inserts a missing EPUB 2 cover, title page, guide, and first spine item', async () => {
  const result = await setCover(fixture(2), {
    data: jpeg,
    mediaType: 'image/jpeg',
  });
  assert.equal(result.action, 'inserted');
  assert.equal(result.cover.epubVersion, 2);
  assert.ok(result.cover.titlePagePath);
  const files = readArchive(result.data);
  const opf = textDecoder.decode(files.get('OPS/package.opf'));
  assert.match(opf, /meta name="cover"/);
  assert.match(opf, /reference type="cover"/);
  const spine = opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/)?.[1] ?? '';
  assert.ok(spine.indexOf('cover-titlepage') < spine.indexOf('chapter'));
});

test('repairs a simple first-spine cover and preserves unrelated files', async () => {
  const input = fixture(3, { firstSpineCover: true });
  const result = await setCover(input, { data: jpeg, mediaType: 'image/jpeg' });
  assert.equal(result.action, 'repaired');
  const files = readArchive(result.data);
  assert.equal(
    textDecoder.decode(files.get('EPUB/chapter.xhtml')),
    '<p>unchanged</p>',
  );
  const inspected = await inspectCover(result.data);
  assert.equal(inspected?.source, 'epub3-property');
});

test('replaces a direct-image first spine item with a valid title page', async () => {
  const files = readArchive(fixture(3));
  files.set('EPUB/images/front.png', png);
  files.set(
    'EPUB/package.opf',
    textEncoder.encode(
      textDecoder
        .decode(files.get('EPUB/package.opf'))
        .replace(
          '</manifest>',
          '<item id="direct-cover" href="images/front.png" media-type="image/png"/></manifest>',
        )
        .replace(
          '<spine>',
          '<spine><itemref idref="direct-cover" linear="no"/>',
        ),
    ),
  );

  const result = await setCover(writeArchive(files), {
    data: png,
    mediaType: 'image/png',
  });
  assert.equal(result.action, 'repaired');
  const opf = textDecoder.decode(
    readArchive(result.data).get('EPUB/package.opf'),
  );
  const spine = opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/)?.[1] ?? '';
  assert.doesNotMatch(spine, /idref="direct-cover"/);
  assert.match(spine, /^<itemref idref="cover-titlepage"\/>/);
});

test('updates a root-level Calibre SVG cover page in place', async () => {
  const result = await setCover(rootLevelFixture({ cover: true }), {
    data: jpeg,
    mediaType: 'image/jpeg',
  });

  assert.equal(result.action, 'replaced');
  assert.equal(result.cover.imagePath, 'cover.jpeg');
  assert.equal(result.cover.titlePagePath, 'titlepage.xhtml');
  assert.deepEqual(result.warnings, []);
  const titlePage = textDecoder.decode(
    readArchive(result.data).get('titlepage.xhtml'),
  );
  assert.match(titlePage, /xlink:href="cover\.jpeg"/);
});

test('inserts missing resources when the OPF is at the archive root', async () => {
  const result = await setCover(rootLevelFixture(), {
    data: jpeg,
    mediaType: 'image/jpeg',
  });

  assert.equal(result.action, 'inserted');
  assert.equal(result.cover.imagePath, 'images/cover.jpg');
  assert.equal(result.cover.titlePagePath, 'titlepage.xhtml');
});

test('strict replacement rejects an EPUB without a detectable cover', async () => {
  await assert.rejects(
    replaceCover(fixture(3), { data: jpeg, mediaType: 'image/jpeg' }),
    (error) => error instanceof EpubError && error.code === 'MISSING_COVER',
  );
});

test('rejects signed EPUBs and image bytes that do not match their media type', async () => {
  const signed = fixture(3, { signed: true, cover: true });
  assert.equal((await inspectCover(signed))?.imagePath, 'EPUB/images/old.jpg');
  await assert.rejects(
    setCover(signed, { data: jpeg, mediaType: 'image/jpeg' }),
    (error) => error instanceof EpubError && error.code === 'SIGNED_EPUB',
  );
  await assert.rejects(
    setCover(fixture(3), { data: jpeg, mediaType: 'image/png' }),
    (error) => error instanceof EpubError && error.code === 'UNSUPPORTED_IMAGE',
  );
});

test('finds an encoded image path through an EPUB 2 guide wrapper', async () => {
  const files = readArchive(fixture(2));
  files.set(
    'OPS/package.opf',
    textEncoder.encode(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Guide</dc:title><dc:language>en</dc:language></metadata><manifest><item id="page" href="jacket.xhtml" media-type="application/xhtml+xml"/><item id="art" href="images/cover%231.png" media-type="image/png"/></manifest><spine><itemref idref="page"/></spine><guide><reference type="cover" href="jacket.xhtml#cover"/></guide></package>`,
    ),
  );
  files.set(
    'OPS/jacket.xhtml',
    textEncoder.encode(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><div id="cover"><img src="images/cover%231.png"/></div></body></html>',
    ),
  );
  files.set('OPS/images/cover#1.png', png);
  const cover = await inspectCover(writeArchive(files));
  assert.equal(cover?.source, 'guide');
  assert.equal(cover?.imagePath, 'OPS/images/cover#1.png');
});

test('preserves a complex existing title page and reports the inserted replacement page', async () => {
  const files = readArchive(fixture(2, { cover: true }));
  const opf = textDecoder
    .decode(files.get('OPS/package.opf'))
    .replace(
      '</manifest>',
      '<item id="jacket" href="jacket.xhtml" media-type="application/xhtml+xml"/></manifest>',
    )
    .replace(
      '</package>',
      '<guide><reference type="cover" href="jacket.xhtml"/></guide></package>',
    );
  files.set('OPS/package.opf', textEncoder.encode(opf));
  files.set(
    'OPS/jacket.xhtml',
    textEncoder.encode(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Special edition</h1><img src="images/old.jpg"/></body></html>',
    ),
  );
  const result = await setCover(writeArchive(files), {
    data: jpeg,
    mediaType: 'image/jpeg',
  });
  assert.equal(result.warnings.length, 1);
  assert.equal(
    textDecoder.decode(readArchive(result.data).get('OPS/jacket.xhtml')),
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Special edition</h1><img src="images/old.jpg"/></body></html>',
  );
});

test('rejects an encrypted existing cover resource', async () => {
  const files = readArchive(fixture(3, { cover: true }));
  files.set(
    'META-INF/encryption.xml',
    textEncoder.encode(
      '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:CipherData><enc:CipherReference URI="EPUB/images/old.jpg"/></enc:CipherData></enc:EncryptedData></encryption>',
    ),
  );
  await assert.rejects(
    setCover(writeArchive(files), { data: jpeg, mediaType: 'image/jpeg' }),
    (error) => error instanceof EpubError && error.code === 'ENCRYPTED_COVER',
  );
});

test('uses the package-media-type rootfile when the container declares multiple renditions', async () => {
  const files = readArchive(fixture(3, { cover: true }));
  files.set(
    'META-INF/container.xml',
    textEncoder.encode(
      '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="META-INF/not-package.xml" media-type="application/xml"/><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  files.set('META-INF/not-package.xml', textEncoder.encode('<not-package/>'));
  assert.equal(
    (await inspectCover(writeArchive(files)))?.imagePath,
    'EPUB/images/old.jpg',
  );
});

test('enforces archive entry limits before cover inspection', async () => {
  await assert.rejects(
    inspectCover(fixture(3), { limits: { maxEntries: 2 } }),
    (error) =>
      error instanceof EpubError && error.code === 'ARCHIVE_LIMIT_EXCEEDED',
  );
  await assert.rejects(
    inspectCover(fixture(3), {
      limits: { maxEntryUncompressedBytes: 4 },
    }),
    (error) =>
      error instanceof EpubError && error.code === 'ARCHIVE_LIMIT_EXCEEDED',
  );
});

test('rejects malformed and traversal ZIP input with typed EPUB errors', async () => {
  await assert.rejects(
    inspectCover(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])),
    (error) => error instanceof EpubError && error.code === 'INVALID_EPUB',
  );

  const unsafe = fixture(3).slice();
  replaceAscii(unsafe, 'mimetype', '../etype');
  await assert.rejects(
    inspectCover(unsafe),
    (error) => error instanceof EpubError && error.code === 'INVALID_EPUB',
  );

  const malformedXml = readArchive(fixture(3));
  malformedXml.set(
    'META-INF/container.xml',
    textEncoder.encode('<container><rootfiles>'),
  );
  await assert.rejects(
    inspectCover(writeArchive(malformedXml)),
    (error) => error instanceof EpubError && error.code === 'INVALID_EPUB',
  );
});

test('honors both title-page aspect-ratio modes', async () => {
  const preserved = await setCover(fixture(3), {
    data: jpeg,
    mediaType: 'image/jpeg',
  });
  const stretched = await setCover(
    fixture(3),
    { data: jpeg, mediaType: 'image/jpeg' },
    { keepAspectRatio: false },
  );
  assert.match(
    textDecoder.decode(
      readArchive(preserved.data).get(preserved.cover.titlePagePath),
    ),
    /preserveAspectRatio="xMidYMid meet"/,
  );
  assert.match(
    textDecoder.decode(
      readArchive(stretched.data).get(stretched.cover.titlePagePath),
    ),
    /preserveAspectRatio="none"/,
  );
});

test('normalizes conflicting markers and selects unique resource IDs and paths', async () => {
  const files = readArchive(fixture(3, { cover: true }));
  files.set('EPUB/images/cover.png', png);
  files.set('EPUB/images/other.png', png);
  files.set(
    'EPUB/package.opf',
    textEncoder.encode(
      textDecoder
        .decode(files.get('EPUB/package.opf'))
        .replace(
          '</manifest>',
          '<item id="existing-path" href="images/cover.png" media-type="image/png"/><item id="other-cover" href="images/other.png" media-type="image/png" properties="cover-image"/></manifest>',
        ),
    ),
  );

  const result = await replaceCover(writeArchive(files), {
    data: png,
    mediaType: 'image/png',
  });
  assert.equal(result.cover.imagePath, 'EPUB/images/cover-2.png');
  assert.equal(result.cover.imageId, 'cover-image-2');
  const opf = textDecoder.decode(
    readArchive(result.data).get('EPUB/package.opf'),
  );
  assert.equal(opf.match(/properties="cover-image"/g)?.length, 1);
});

test('Node file adapters inspect input and atomically write an explicit output', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'delb-epub-node-'));
  try {
    const inputPath = path.join(directory, 'input.epub');
    const coverPath = path.join(directory, 'cover.png');
    const outputPath = path.join(directory, 'output.epub');
    await Promise.all([
      writeFile(inputPath, fixture(3, { cover: true })),
      writeFile(coverPath, png),
    ]);

    assert.equal((await inspectCoverFile(inputPath))?.mediaType, 'image/jpeg');
    const result = await setCoverFile(inputPath, coverPath, { outputPath });
    assert.equal(result.cover.mediaType, 'image/png');
    assert.equal(
      (await inspectCover(Uint8Array.from(await readFile(outputPath))))
        ?.mediaType,
      'image/png',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fixture(version, options = {}) {
  const root = version === 2 ? 'OPS' : 'EPUB';
  const coverManifest = options.cover
    ? `<item id="cover-image" href="images/old.jpg" media-type="image/jpeg"${version === 3 ? ' properties="cover-image"' : ''}/>`
    : options.firstSpineCover
      ? '<item id="front" href="front.xhtml" media-type="application/xhtml+xml"/><item id="front-image" href="images/front.png" media-type="image/png"/>'
      : '';
  const metadataCover =
    version === 2 && options.cover
      ? '<meta name="cover" content="cover-image"/>'
      : '';
  const spine = options.firstSpineCover
    ? '<itemref idref="front"/><itemref idref="chapter"/>'
    : '<itemref idref="chapter"/>';
  const files = new Map([
    ['mimetype', textEncoder.encode('application/epub+zip')],
    [
      'META-INF/container.xml',
      textEncoder.encode(
        `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="${root}/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      ),
    ],
    [
      `${root}/package.opf`,
      textEncoder.encode(
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:test</dc:identifier><dc:title>Test</dc:title><dc:language>en</dc:language>${metadataCover}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>${coverManifest}</manifest><spine>${spine}</spine></package>`,
      ),
    ],
    [`${root}/chapter.xhtml`, textEncoder.encode('<p>unchanged</p>')],
  ]);
  if (options.cover) files.set(`${root}/images/old.jpg`, jpeg);
  if (options.firstSpineCover) {
    files.set(
      `${root}/front.xhtml`,
      textEncoder.encode(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="images/front.png"/></body></html>',
      ),
    );
    files.set(`${root}/images/front.png`, png);
  }
  if (options.signed)
    files.set('META-INF/signatures.xml', textEncoder.encode('<signatures/>'));
  return writeArchive(files);
}

function rootLevelFixture(options = {}) {
  const coverManifest = options.cover
    ? '<item id="cover" href="cover.jpeg" media-type="image/jpeg"/><item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>'
    : '';
  const coverMetadata = options.cover
    ? '<meta name="cover" content="cover"/>'
    : '';
  const coverSpine = options.cover ? '<itemref idref="titlepage"/>' : '';
  const guide = options.cover
    ? '<guide><reference type="cover" href="titlepage.xhtml" title="Cover"/></guide>'
    : '';
  const files = new Map([
    ['mimetype', textEncoder.encode('application/epub+zip')],
    [
      'META-INF/container.xml',
      textEncoder.encode(
        '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
    ],
    [
      'content.opf',
      textEncoder.encode(
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:root</dc:identifier><dc:title>Root OPF</dc:title><dc:language>en</dc:language>${coverMetadata}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>${coverManifest}</manifest><spine>${coverSpine}<itemref idref="chapter"/></spine>${guide}</package>`,
      ),
    ],
    [
      'chapter.xhtml',
      textEncoder.encode(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>Text</p></body></html>',
      ),
    ],
  ]);
  if (options.cover) {
    files.set('cover.jpeg', jpeg);
    files.set(
      'titlepage.xhtml',
      textEncoder.encode(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image width="100" height="100" xlink:href="cover.jpeg"/></svg></div></body></html>',
      ),
    );
  }
  return writeArchive(files);
}

function replaceAscii(bytes, search, replacement) {
  assert.equal(search.length, replacement.length);
  const wanted = textEncoder.encode(search);
  const value = textEncoder.encode(replacement);
  for (let offset = 0; offset <= bytes.length - wanted.length; offset += 1) {
    if (wanted.every((byte, index) => bytes[offset + index] === byte)) {
      bytes.set(value, offset);
    }
  }
}
