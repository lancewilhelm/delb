import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { directory, sha256 } from './setup.mjs';

const readJSON = async (filename) =>
  JSON.parse(await readFile(path.join(directory, filename), 'utf8'));
const current = await readJSON('output/report.json');
const original = await readJSON('output/original-parser/report.json');
const formal = await readJSON('output/epubcheck-summary.json');
const downloads = await readJSON('downloads.json');
const code = {};
for (const filename of [
  'convert.mjs',
  'check.mjs',
  'setup.mjs',
  'validate.mjs',
  'package-lock.json',
])
  code[filename] = sha256(await readFile(path.join(directory, filename)));
const evidence = {
  verdict:
    'JavaScript conversion demonstrated on this corpus; production integration and broader fidelity remain unproven',
  foliateCommit: '78914aef4466eb960965702401634c2cb348e9b1',
  code,
  samples: [],
};
for (const sample of current.samples) {
  const baseline = original.samples.find((item) => item.name === sample.name);
  const validation = formal.find((item) => item.name === sample.name);
  const input = await readFile(
    path.join(directory, '.cache/fixtures', sample.name),
  );
  if (sha256(input) !== downloads[`fixtures/${sample.name}`].sha256)
    throw new Error(`Fixture changed: ${sample.name}`);
  if (
    sample.output &&
    sha256(await readFile(path.join(directory, 'output', sample.output))) !==
      sample.outputHash
  )
    throw new Error(`Converted output changed: ${sample.name}`);
  evidence.samples.push({
    name: sample.name,
    diagnostic: sample.diagnostic ?? false,
    sourceHash: sha256(input),
    result: sample.result,
    originalParserResult: baseline?.result,
    originalParserError: baseline?.error?.split('\n')[0],
    version: sample.version,
    compression: sample.compression,
    sections: sample.sections,
    navigation: sample.navigation,
    navEntries: sample.navEntries,
    assets: sample.assets?.map(({ type }) => type),
    independentReference: sample.independentReference,
    sourceTextPreserved: sample.textChecks?.every((check) => check.unchanged),
    warnings: sample.warnings,
    epubcheck: validation,
  });
}
await writeFile(
  path.join(directory, 'evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  'Recorded checked fixtures, parser comparison, and EPUBCheck results in evidence.json.',
);
