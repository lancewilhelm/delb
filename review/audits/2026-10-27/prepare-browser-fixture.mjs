import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const require = createRequire(
  new URL('../../../packages/epub/package.json', import.meta.url),
);
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const files = unzipSync(await readFile('review/demo/ordinary.epub'));
files['OEBPS/content.opf'] = strToU8(
  strFromU8(files['OEBPS/content.opf']).replace(
    'Synthetic ordinary book',
    'Synthetic Audit Origin Proof',
  ),
);
for (const file of ['OEBPS/chapter1.xhtml', 'OEBPS/chapter2.xhtml']) {
  files[file] = strToU8(
    strFromU8(files[file]).replace(
      '</body>',
      '<script>parent.__delbAuditParentAccess="executed";parent.document.body.dataset.auditEpubScript="executed";</script></body>',
    ),
  );
}
const { mimetype, ...contents } = files;
await writeFile(
  'review/demo/audit-script.epub',
  zipSync({ mimetype: [mimetype, { level: 0 }], ...contents }),
);
console.log('Generated synthetic EPUB with harmless parent-access markers');
