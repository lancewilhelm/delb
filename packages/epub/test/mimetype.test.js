import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { EpubError, inspectCover, setCover } from '../dist/index.js';
import { readArchive, writeArchive } from '../dist/archive.js';

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);
const MIME = 'application/epub+zip';
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const image = { data: png, mediaType: 'image/png' };
const repair = { repairMimetype: true };

function fixture(version = 3) {
  const manifestNav =
    version === 3
      ? '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'
      : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>';
  return new Map([
    ['mimetype', encode(MIME)],
    [
      'META-INF/container.xml',
      encode(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
    ],
    [
      'EPUB/book.opf',
      encode(
        `<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="${version}.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:synthetic-war</dc:identifier><dc:title>Synthetic public domain test</dc:title><dc:language>en</dc:language>${version === 2 ? '<meta name="cover" content="cover"/>' : '<meta property="dcterms:modified">2026-10-20T00:00:00Z</meta>'}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.png" media-type="image/png" ${version === 3 ? 'properties="cover-image"' : ''}/>${manifestNav}</manifest><spine ${version === 2 ? 'toc="ncx"' : ''}><itemref idref="chapter"/></spine></package>`,
      ),
    ],
    [
      'EPUB/chapter.xhtml',
      encode(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Synthetic chapter</title></head><body><h1 id="start">Chapter</h1><p>All content here is synthetic. Preserve these bytes.</p></body></html>',
      ),
    ],
    ['EPUB/cover.png', png],
    ...(version === 3
      ? [
          [
            'EPUB/nav.xhtml',
            encode(
              '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#start">Chapter</a></li></ol></nav></body></html>',
            ),
          ],
        ]
      : [
          [
            'EPUB/toc.ncx',
            encode(
              '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:synthetic-war"/></head><docTitle><text>Synthetic public domain test</text></docTitle><navMap><navPoint id="chapter" playOrder="1"><navLabel><text>Chapter</text></navLabel><content src="chapter.xhtml#start"/></navPoint></navMap></ncx>',
            ),
          ],
        ]),
  ]);
}
function zip(files) {
  return zipSync(Object.fromEntries(files));
}
function change(files, name, from, to) {
  files.set(name, encode(decode(files.get(name)).replace(from, to)));
}
function assertCanonical(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint16(28, true), 0);
  const nameLength = view.getUint16(26, true);
  assert.equal(decode(bytes.subarray(30, 30 + nameLength)), 'mimetype');
  assert.deepEqual(readArchive(bytes).get('mimetype'), encode(MIME));
}
const variants = new Map([
  ['missing', undefined],
  ['empty', encode('')],
  ['trailing LF', encode(`${MIME}\n`)],
  ['whitespace-only', encode(' \r\n\t')],
  ['CRLF and spaces', encode(`\t ${MIME}\r\n`)],
  ['UTF-8 BOM', encode(`\uFEFF${MIME}`)],
  ['BOM and newline', encode(`\uFEFF${MIME}\n`)],
]);
for (const version of [2, 3]) {
  for (const [label, marker] of variants) {
    test(`EPUB ${version}: opt-in normalization of ${label} preserves reading resources`, async () => {
      const files = fixture(version);
      if (marker) files.set('mimetype', marker);
      else files.delete('mimetype');
      const input = zip(files),
        before = input.slice();
      if (label !== 'UTF-8 BOM')
        await assert.rejects(setCover(input, image), { code: 'INVALID_EPUB' });
      else assert.ok(await inspectCover(input)); // Existing TextDecoder behavior strips the BOM.
      const result = await setCover(input, image, repair);
      assert.equal(result.mimetypeRepaired, true);
      assert.match(result.warnings.join(' '), /Normalized.*mimetype/);
      assertCanonical(result.data);
      assert.ok(await inspectCover(result.data));
      assert.deepEqual(input, before);
      const output = readArchive(result.data);
      for (const name of [
        'EPUB/chapter.xhtml',
        version === 3 ? 'EPUB/nav.xhtml' : 'EPUB/toc.ncx',
      ])
        assert.deepEqual(output.get(name), files.get(name));
    });
  }
}
test('canonical input does not need repair or a repair warning', async () => {
  const result = await setCover(writeArchive(fixture()), image, repair);
  assert.equal(result.mimetypeRepaired, false);
  assert.equal(
    result.warnings.some((w) => w.includes('mimetype')),
    false,
  );
  assertCanonical(result.data);
});

for (const [label, marker] of new Map([
  ['another MIME type', encode('application/zip')],
  ['arbitrary text', encode('not an epub')],
  ['uppercase value', encode('APPLICATION/EPUB+ZIP')],
  ['MIME parameters', encode(`${MIME}; charset=utf-8`)],
  ['NUL suffix', encode(`${MIME}\0`)],
  ['invalid UTF-8', new Uint8Array([0xff, 0xfe, 0xff])],
  ['UTF-16', new Uint8Array(Buffer.from(MIME, 'utf16le'))],
  ['oversized whitespace', encode(' '.repeat(129))],
]))
  test(`does not overwrite ${label}`, async () => {
    const files = fixture();
    files.set('mimetype', marker);
    const input = zip(files),
      before = input.slice();
    await assert.rejects(setCover(input, image, repair), {
      code: 'INVALID_EPUB',
    });
    assert.deepEqual(input, before);
  });

const invalidStructures = new Map([
  [
    'unrelated ZIP',
    (files) => {
      files.clear();
      files.set('notes.txt', encode('ordinary archive'));
    },
  ],
  ['missing container', (files) => files.delete('META-INF/container.xml')],
  [
    'wrong container namespace',
    (files) =>
      change(
        files,
        'META-INF/container.xml',
        'urn:oasis:names:tc:opendocument:xmlns:container',
        'urn:not-epub',
      ),
  ],
  [
    'wrong container version',
    (files) =>
      change(files, 'META-INF/container.xml', 'version="1.0"', 'version="2.0"'),
  ],
  [
    'nested rootfile',
    (files) =>
      change(
        files,
        'META-INF/container.xml',
        '<rootfile ',
        '<wrapper><rootfile ',
      ) ||
      change(
        files,
        'META-INF/container.xml',
        '/></rootfiles>',
        '/></wrapper></rootfiles>',
      ),
  ],
  [
    'wrong rootfile media type',
    (files) =>
      change(
        files,
        'META-INF/container.xml',
        'application/oebps-package+xml',
        'text/xml',
      ),
  ],
  ['missing OPF', (files) => files.delete('EPUB/book.opf')],
  [
    'wrong OPF namespace',
    (files) =>
      change(
        files,
        'EPUB/book.opf',
        'http://www.idpf.org/2007/opf',
        'urn:not-epub',
      ),
  ],
  [
    'missing metadata',
    (files) =>
      change(files, 'EPUB/book.opf', '<dc:language>en</dc:language>', ''),
  ],
  [
    'duplicate manifest ID',
    (files) => change(files, 'EPUB/book.opf', 'id="cover"', 'id="chapter"'),
  ],
  ['missing local resource', (files) => files.delete('EPUB/chapter.xhtml')],
  [
    'empty spine',
    (files) => change(files, 'EPUB/book.opf', '<itemref idref="chapter"/>', ''),
  ],
  [
    'bad spine reference',
    (files) =>
      change(files, 'EPUB/book.opf', 'idref="chapter"', 'idref="absent"'),
  ],
  [
    'non-XHTML reading content',
    (files) =>
      files.set(
        'EPUB/chapter.xhtml',
        encode('<notes>Not a reading document</notes>'),
      ),
  ],
  ['path traversal', (files) => files.set('../outside.txt', encode('unsafe'))],
]);
for (const [label, changeStructure] of invalidStructures)
  test(`repair rejects ${label} without changing input`, async () => {
    const files = fixture();
    files.delete('mimetype');
    changeStructure(files);
    const input = zip(files),
      before = input.slice();
    await assert.rejects(
      setCover(input, image, repair),
      (e) => e instanceof EpubError && e.code === 'INVALID_EPUB',
    );
    assert.deepEqual(input, before);
  });

for (const [label, marker] of variants) {
  for (const protection of ['signed', 'encrypted-cover', 'encrypted-mimetype'])
    test(`${label} does not bypass ${protection}`, async () => {
      const files = fixture();
      if (marker) files.set('mimetype', marker);
      else files.delete('mimetype');
      if (protection === 'signed')
        files.set('META-INF/signatures.xml', encode('<signatures/>'));
      else
        files.set(
          'META-INF/encryption.xml',
          encode(
            `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:CipherData><enc:CipherReference URI="${protection === 'encrypted-cover' ? 'EPUB/cover.png' : 'mimetype'}"/></enc:CipherData></enc:EncryptedData></encryption>`,
          ),
        );
      const input = zip(files),
        before = input.slice();
      await assert.rejects(setCover(input, image, repair), {
        code:
          protection === 'signed'
            ? 'SIGNED_EPUB'
            : protection === 'encrypted-cover'
              ? 'ENCRYPTED_COVER'
              : 'INVALID_EPUB',
      });
      assert.deepEqual(input, before);
    });
}
test('repair still enforces archive limits before decompression', async () => {
  const files = fixture();
  files.delete('mimetype');
  await assert.rejects(
    setCover(zip(files), image, { ...repair, limits: { maxEntries: 2 } }),
    { code: 'ARCHIVE_LIMIT_EXCEEDED' },
  );
});
