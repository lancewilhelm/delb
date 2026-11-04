import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(filename);
      return entry.name.endsWith('.md') ? [filename] : [];
    }),
  );
  return nested.flat();
}

function withoutFences(markdown) {
  let fence = null;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
          fence = null;
        return '';
      }
      return fence ? '' : line;
    })
    .join('\n');
}

function headingAnchors(markdown) {
  const seen = new Map();
  const anchors = new Set();
  for (const match of withoutFences(markdown).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = match[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+#+\s*$/, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  }
  return anchors;
}

const files = [
  path.join(root, 'README.md'),
  path.join(root, 'GLOSSARY.md'),
  ...(await markdownFiles(path.join(root, 'docs'))),
];
const failures = [];
const anchorsByFile = new Map();
let checked = 0;

for (const filename of files) {
  const markdown = withoutFences(await readFile(filename, 'utf8'));
  for (const match of markdown.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const target = match[1].trim().match(/^(?:<([^>]+)>|(\S+))/);
    const href = target?.[1] ?? target?.[2];
    if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
    checked++;
    try {
      const hash = href.indexOf('#');
      const resource = decodeURIComponent(
        hash < 0 ? href : href.slice(0, hash),
      );
      const anchor = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
      const destination = resource
        ? path.resolve(path.dirname(filename), resource)
        : filename;
      const info = await stat(destination);
      if (anchor && info.isFile() && destination.endsWith('.md')) {
        if (!anchorsByFile.has(destination))
          anchorsByFile.set(
            destination,
            headingAnchors(await readFile(destination, 'utf8')),
          );
        if (!anchorsByFile.get(destination).has(anchor))
          throw new Error(`missing heading #${anchor}`);
      }
    } catch (error) {
      failures.push(
        `${path.relative(root, filename)}: ${href}: ${error.message}`,
      );
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${checked} local inline links in ${files.length} Markdown files.`,
  );
}
