import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      entry.isDirectory() &&
      !['node_modules', 'dist', 'baseline'].includes(entry.name)
    ) {
      files.push(...(await testFiles(path)));
    } else if (entry.isFile() && /\.test\.(ts|js|mjs)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const files = (
  await Promise.all(
    ['app', 'server', 'packages/epub/test', 'review'].map(testFiles),
  )
)
  .flat()
  .sort();
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
});
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
