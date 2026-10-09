import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { setCover } from '../dist/index.js';
import { writeArchive } from '../dist/archive.js';

const outputDirectory = path.resolve(
  process.argv.slice(2).find((argument) => argument !== '--') ?? 'test-output',
);
const encode = (value) => new TextEncoder().encode(value);
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

await mkdir(outputDirectory, { recursive: true });
for (const version of [2, 3]) {
  const input = version === 2 ? epub2() : epub3();
  const result = await setCover(input, { data: png, mediaType: 'image/png' });
  await writeFile(
    path.join(outputDirectory, `cover-epub${version}.epub`),
    result.data,
  );
}

function baseFiles(root) {
  return new Map([
    ['mimetype', encode('application/epub+zip')],
    [
      'META-INF/container.xml',
      encode(
        `<?xml version="1.0" encoding="UTF-8"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="${root}/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      ),
    ],
    [
      `${root}/chapter.xhtml`,
      encode(
        '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>Chapter</h1><p>Text.</p></body></html>',
      ),
    ],
  ]);
}

function epub2() {
  const files = baseFiles('OPS');
  files.set(
    'OPS/package.opf',
    encode(
      '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:delb-epub2</dc:identifier><dc:title>EPUB 2 Test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="chapter"/></spine></package>',
    ),
  );
  files.set(
    'OPS/toc.ncx',
    encode(
      '<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:delb-epub2"/></head><docTitle><text>EPUB 2 Test</text></docTitle><navMap><navPoint id="chapter" playOrder="1"><navLabel><text>Chapter</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>',
    ),
  );
  return writeArchive(files);
}

function epub3() {
  const files = baseFiles('EPUB');
  files.set(
    'EPUB/package.opf',
    encode(
      '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:delb-epub3</dc:identifier><dc:title>EPUB 3 Test</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-09-27T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    ),
  );
  files.set(
    'EPUB/nav.xhtml',
    encode(
      '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Navigation</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>',
    ),
  );
  return writeArchive(files);
}
