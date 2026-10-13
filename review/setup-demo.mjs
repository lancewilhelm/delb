import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { createRequire } from 'node:module';
import { assertNoEnvironmentFiles, assertEmptyStorage } from './isolation.mjs';
const require = createRequire(
  new URL('../packages/epub/package.json', import.meta.url),
);
const { zipSync, strToU8 } = require('fflate');

await assertNoEnvironmentFiles();
await assertEmptyStorage();
await mkdir('review/demo', { recursive: true });
for (const directory of ['data', 'library', 'dropbox'])
  await mkdir(directory, { recursive: true });
const client = createClient({ url: 'file:./review/demo/synthetic.db' });
try {
  const files = (await readdir('.drizzle/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of files)
    await client.executeMultiple(
      await readFile(`.drizzle/migrations/${name}`, 'utf8'),
    );
  await client.execute({
    sql: 'INSERT INTO global_settings (user_id, settings, updated_at) VALUES (?, ?, ?)',
    args: [
      '00000000-0000-0000-0000-000000000000',
      JSON.stringify({ allowRegistration: true, dropbox: { enabled: false } }),
      Math.floor(Date.now() / 1000),
    ],
  });
} finally {
  client.close();
}

const chapter = (number) =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${number}</title></head><body><h1>Chapter ${number}</h1>${Array.from({ length: 30 }, (_, i) => `<p>Ordinary synthetic reading paragraph ${i + 1}. This text has no personal data. <em>Formatting</em> and navigation should work in both reading modes.</p>`).join('')}<p><a href="chapter${number === 1 ? 2 : 1}.xhtml">Next chapter</a></p></body></html>`;
const entries = {
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8(
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  ),
  'OEBPS/content.opf': strToU8(
    '<?xml version="1.0"?><package version="3.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:synthetic-delb-review</dc:identifier><dc:title>Synthetic ordinary book</dc:title><dc:creator>Synthetic Author</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-12T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="two" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
  ),
  'OEBPS/nav.xhtml': strToU8(
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Chapter 1</a></li><li><a href="chapter2.xhtml">Chapter 2</a></li></ol></nav></body></html>',
  ),
  'OEBPS/chapter1.xhtml': strToU8(chapter(1)),
  'OEBPS/chapter2.xhtml': strToU8(chapter(2)),
};
await writeFile('review/demo/ordinary.epub', zipSync(entries));
await copyFile(
  'node_modules/epubjs/dist/epub.min.js',
  'review/demo/epub.min.js',
);
const rootRequire = createRequire(import.meta.url);
const epubRequire = createRequire(rootRequire.resolve('epubjs/package.json'));
await copyFile(
  epubRequire.resolve('jszip/dist/jszip.min.js'),
  'review/demo/jszip.min.js',
);
console.log(
  'Fresh synthetic database and ordinary two-chapter EPUB created; no real data used.',
);
await writeFile('review/demo/.synthetic-review', 'synthetic-delb-review\n');
