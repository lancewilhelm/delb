import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const directory = path.dirname(fileURLToPath(import.meta.url));
export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
const foliate = '78914aef4466eb960965702401634c2cb348e9b1';
const libmobi = '906274205c11944b628da1c553b255acb1af7c55';

export const downloads = [
  ...['mobi.js', 'LICENSE'].map((name) => ({
    file: `foliate/${name}`,
    url: `https://raw.githubusercontent.com/johnfactotum/foliate-js/${foliate}/${name}`,
  })),
  ...[
    'sample-cp1252.mobi',
    'sample-unicode-huffdic.mobi',
    'sample-unicode-uncompressed.mobi',
    'sample-ncx.mobi',
    'sample-obfuscated-fonts.mobi',
    'sample-multimedia.mobi',
    'sample-drm-v1.mobi',
    'sample-drm_pidLTKULBB^5V-v2.mobi',
  ].map((name) => ({
    file: `fixtures/${name}`,
    url: `https://raw.githubusercontent.com/bfabiszewski/libmobi/${libmobi}/tests/samples/${name}`,
  })),
  {
    file: 'fixtures/alice.mobi',
    url: 'https://www.gutenberg.org/ebooks/11.kindle.images',
  },
  {
    file: 'fixtures/alice.azw3',
    url: 'https://www.gutenberg.org/ebooks/11.kf8.images',
  },
  {
    file: 'fixtures/alice-reference.epub',
    url: 'https://www.gutenberg.org/ebooks/11.epub3.images',
  },
];

export async function setup() {
  const locked = JSON.parse(
    await readFile(path.join(directory, 'downloads.json'), 'utf8'),
  );
  const actual = {};
  for (const item of downloads) {
    if (!locked[item.file] || locked[item.file].url !== item.url)
      throw new Error(`Missing or changed download lock: ${item.file}`);
    const destination = path.join(directory, '.cache', item.file);
    let bytes;
    try {
      bytes = await readFile(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetch(item.url, {
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok)
        throw new Error(`Download ${response.status}: ${item.url}`);
      bytes = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const hash = sha256(bytes);
    if (locked[item.file] && locked[item.file].sha256 !== hash)
      throw new Error(
        `Checksum changed for ${item.file}; review the upstream file before updating downloads.json`,
      );
    actual[item.file] = { url: item.url, sha256: hash, bytes: bytes.length };
  }
  await writeFile(
    path.join(directory, '.cache', 'downloads.actual.json'),
    `${JSON.stringify(actual, null, 2)}\n`,
  );
  const source = await readFile(
    path.join(directory, '.cache/foliate/mobi.js'),
    'utf8',
  );
  const needle = String.raw`        const str = this.mobi.decode(fragRaw.slice(off))
        const selector = getFragmentSelector(str)
        this.#setFragmentSelector(fid, off, selector)`;
  const replacement = String.raw`        const str = this.mobi.decode(fragRaw.slice(off))
        const insertionTarget = off === 0
            && frag.selector?.match(/\[@(id|name|aid)=['"]([^'"]+)['"]\]$/)
        const selector = getFragmentSelector(str)
            ?? (insertionTarget
                ? getFragmentSelector(' ' + insertionTarget[1] + '="' + insertionTarget[2] + '"')
                : undefined)
        this.#setFragmentSelector(fid, off, selector)`;
  if (source.split(needle).length !== 2)
    throw new Error('Pinned Foliate fragment resolver changed');
  await writeFile(
    path.join(directory, '.cache/foliate/mobi-conversion.js'),
    `// Feasibility adapter. Original source and MIT notice: mobi.js and LICENSE.\n${source.replace(needle, replacement)}`,
  );
  return actual;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await setup();
  console.log(
    `Prepared ${Object.keys(result).length} pinned-source or checksummed downloads.`,
  );
}
