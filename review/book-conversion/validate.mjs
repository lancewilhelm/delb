// Development-only EPUBCheck. Java is never used by the converter.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { directory, sha256 } from './setup.mjs';

const cache = path.join(directory, '.cache');
async function download(url, expectedHash, filename) {
  let bytes;
  try {
    bytes = await readFile(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log(`Downloading validation tool: ${path.basename(filename)}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Download ${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(filename, bytes);
  }
  if (sha256(bytes) !== expectedHash)
    throw new Error(`Validation tool checksum mismatch: ${filename}`);
  return bytes;
}
await mkdir(cache, { recursive: true });
const jar = path.join(cache, 'epubcheck-5.4.0', 'epubcheck.jar');
try {
  await access(jar);
} catch {
  const bytes = await download(
    'https://github.com/w3c/epubcheck/releases/download/v5.4.0/epubcheck-5.4.0.zip',
    '33350c61038e71dfb3d45a76aed04bf5481e6d5500cb780f6e98db8bbd15a28c',
    path.join(cache, 'epubcheck-5.4.0.zip'),
  );
  for (const [filename, data] of Object.entries(unzipSync(bytes))) {
    if (filename.endsWith('/')) continue;
    const destination = path.resolve(cache, filename);
    if (!destination.startsWith(`${cache}${path.sep}`))
      throw new Error('Unsafe validation archive path');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
}
let java = process.env.EPUBCHECK_JAVA || 'java';
if (spawnSync(java, ['-version']).status !== 0) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error(
      'EPUBCheck requires Java 21. Set EPUBCHECK_JAVA or install a Java runtime for this development check.',
    );
  java = path.join(cache, 'jre', 'Contents', 'Home', 'bin', 'java');
  try {
    await access(java);
  } catch {
    const filename = path.join(cache, 'temurin-21.0.13+9-jre.tar.gz');
    await download(
      'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.13_9.tar.gz',
      '225bab0a09491ef06835488cd942f5d2befa9a0410a2484f0c8bbcf7506ec09a',
      filename,
    );
    await mkdir(path.join(cache, 'jre'), { recursive: true });
    execFileSync('tar', [
      '-xzf',
      filename,
      '-C',
      path.join(cache, 'jre'),
      '--strip-components=1',
    ]);
  }
}
const report = JSON.parse(
  await readFile(path.join(directory, 'output', 'report.json'), 'utf8'),
);
const validations = [];
for (const sample of report.samples.filter((sample) => sample.output)) {
  const filename = path.join(directory, 'output', sample.output);
  if (sha256(await readFile(filename)) !== sample.outputHash)
    throw new Error(`Output changed: ${sample.output}`);
  const jsonFile = path.join(
    directory,
    'output',
    `${sample.output}.epubcheck.json`,
  );
  const result = spawnSync(java, ['-jar', jar, filename, '-j', jsonFile], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const details = JSON.parse(await readFile(jsonFile, 'utf8'));
  const messages = details.messages ?? [];
  const errors = messages.filter((message) =>
    ['ERROR', 'FATAL'].includes(message.severity),
  );
  validations.push({
    name: sample.name,
    exitCode: result.status,
    errors: errors.length,
    warnings: messages.filter((message) => message.severity === 'WARNING')
      .length,
  });
  console.log(
    `${sample.name}: EPUBCheck exit ${result.status}, ${errors.length} errors`,
  );
}
await writeFile(
  path.join(directory, 'output', 'epubcheck-summary.json'),
  `${JSON.stringify(validations, null, 2)}\n`,
);
if (validations.some((validation) => validation.exitCode !== 0))
  process.exitCode = 1;
