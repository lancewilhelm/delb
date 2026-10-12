import { access, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const commit = 'dd7a0fcbc4d1e0e51a6b98a36b10ef06b2ee0d1e';
for (const name of [
  'app/pages/books/[id]/index.vue',
  'app/pages/series/[id].vue',
  'server/utils/books/external-image.ts',
  'server/api/books/index.get.ts',
  'server/api/books/[id]/cover.get.ts',
  'server/utils/books/cover-delivery.ts',
]) {
  const target = path.join('review/baseline', name);
  try {
    await access(target);
    continue;
  } catch {
    /* Prepare only missing source fixtures. */
  }
  const bytes = execFileSync('git', ['show', `${commit}:${name}`]);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
console.log('Baseline source fixtures ready; existing fixtures preserved.');
