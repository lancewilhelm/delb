import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const vue = await readFile(
  'review/baseline/app/pages/books/[id]/index.vue',
  'utf8',
);
const baseline = vue.slice(
  vue.indexOf('function sanitizeDescriptionHtml('),
  vue.indexOf('\nconst safeDescriptionHtml'),
);
for (const [name, source] of [
  ['baseline', `export ${baseline}`],
  ['patched', await readFile('app/utils/descriptionHtml.ts', 'utf8')],
]) {
  const result = await transform(source, { loader: 'ts', format: 'esm' });
  await writeFile(`review/demo/description-${name}.js`, result.code);
}
console.log(
  'Native browser comparison compiled from baseline and candidate source.',
);
