import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readFile,
  stat,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build, transform } from 'esbuild';
import {
  DOMParser,
  XMLSerializer,
} from '../packages/epub/node_modules/@xmldom/xmldom/lib/index.js';

const baseline = process.env.REVIEW_BASELINE === '1';
const root = process.cwd();
const sourceRoot = baseline ? path.join(root, 'review/baseline') : root;
globalThis.defineEventHandler = (fn) => fn;
globalThis.createError = (opts) =>
  Object.assign(new Error(opts.statusMessage), opts);
globalThis.setResponseStatus = () => {};
globalThis.setHeader = () => {};
globalThis.getQuery = (event) => event.query ?? {};
globalThis.getRouterParam = () => 'synthetic-book';

async function loadSource(relative) {
  const source = await readFile(path.join(sourceRoot, relative), 'utf8');
  const result = await build({
    stdin: {
      contents: source
        .replace(
          /import \{ readFile(?:, stat)? \} from 'node:fs\/promises';/g,
          'const { readFile, stat } = globalThis.reviewFs;',
        )
        .replace('10_000', '30'),
      resolveDir: sourceRoot,
      sourcefile: relative,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'isolated-fixtures',
        setup(builder) {
          builder.onResolve({ filter: /^(~\/|~~\/)/ }, ({ path: name }) => ({
            path: name,
            namespace: 'fixture',
          }));
          builder.onLoad(
            { filter: /.*/, namespace: 'fixture' },
            async ({ path: name }) => {
              if (name.includes('cover-delivery'))
                return {
                  contents: (
                    await readFile(
                      path.join(
                        sourceRoot,
                        'server/utils/books/cover-delivery.ts',
                      ),
                      'utf8',
                    )
                  ).replace(
                    "import { readFile, stat } from 'node:fs/promises';",
                    'const { readFile, stat } = globalThis.reviewFs;',
                  ),
                  loader: 'ts',
                  resolveDir: root,
                };
              if (name.endsWith('/auth'))
                return {
                  contents:
                    'export const auth = { api: { getSession: async () => ({ user: { id: "synthetic-reader" } }) } };',
                };
              if (name.endsWith('/logger'))
                return {
                  contents:
                    'export const logger = { debug() {}, info() {}, warn() {}, error() {} };',
                };
              if (name.endsWith('/db/cloud'))
                return {
                  contents: 'export const cloudDb = globalThis.reviewDb;',
                };
              if (name.endsWith('/db/schema'))
                return {
                  contents: `export const USER_BOOK_STATUSES = ['reading']; export const ${['authors', 'bookAuthors', 'bookFiles', 'books', 'collectionBooks', 'collectionMembers', 'publishers', 'series', 'userBookStatus'].map((name) => `${name} = new Proxy({}, {get: (_, key) => String(key)})`).join(', ')};`,
                };
              if (name.endsWith('/books/cover-url'))
                return {
                  contents:
                    'export const buildBookCoverUrl = () => "/synthetic-cover";',
                };
              throw new Error(`Unexpected source import: ${name}`);
            },
          );
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
}

function installStructuralDom() {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const sample = parser.parseFromString('<div/>', 'application/xml');
  const proto = Object.getPrototypeOf(sample.documentElement);
  Object.defineProperty(proto, 'innerHTML', {
    configurable: true,
    get() {
      return Array.from(this.childNodes)
        .map((node) => serializer.serializeToString(node))
        .join('');
    },
    set(value) {
      while (this.firstChild) this.removeChild(this.firstChild);
      const parsed = parser.parseFromString(
        `<div>${value}</div>`,
        'application/xml',
      );
      function prepare(node) {
        if (!node.childNodes) node.childNodes = [];
        for (const child of Array.from(node.childNodes)) prepare(child);
        return node;
      }
      for (const child of Array.from(parsed.documentElement.childNodes))
        this.appendChild(prepare(this.ownerDocument.importNode(child, true)));
    },
  });
  proto.querySelectorAll = function (selector) {
    const tags = selector.split(',');
    const found = [];
    function visit(node) {
      for (const child of Array.from(node.childNodes)) {
        if (
          child.nodeType === 1 &&
          (selector === '*' || tags.includes(child.tagName.toLowerCase()))
        )
          found.push(child);
        visit(child);
      }
    }
    visit(this);
    return found;
  };
  proto.remove = function () {
    this.parentNode?.removeChild(this);
  };
  // Browser HTML elements have uppercase tag names. The adapter is only for
  // traversal regression checks; it does not claim browser parser coverage.
  const createElement = sample.createElement;
  const docProto = Object.getPrototypeOf(sample);
  docProto.createElement = function (name) {
    return createElement.call(this, name.toUpperCase());
  };
  Object.defineProperty(proto, 'tagName', {
    configurable: true,
    get() {
      return this.nodeName.toUpperCase();
    },
    set(value) {
      this.nodeName = value;
    },
  });
  globalThis.window = {};
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  globalThis.document = {
    implementation: {
      createHTMLDocument: () =>
        parser.parseFromString('<html/>', 'application/xml'),
    },
  };
}

test('description sanitizer strips nested handlers and unsafe links, retaining basic formatting', async () => {
  installStructuralDom();
  let fn;
  if (baseline) {
    const vue = await readFile(
      path.join(sourceRoot, 'app/pages/books/[id]/index.vue'),
      'utf8',
    );
    const code = vue.slice(
      vue.indexOf('function sanitizeDescriptionHtml('),
      vue.indexOf('\nconst safeDescriptionHtml'),
    );
    const compiled = await transform(`export ${code}`, {
      loader: 'ts',
      format: 'esm',
    });
    fn = (
      await import(
        `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
      )
    ).sanitizeDescriptionHtml;
  } else {
    const compiled = await transform(
      await readFile('app/utils/descriptionHtml.ts', 'utf8'),
      { loader: 'ts', format: 'esm' },
    );
    fn = (
      await import(
        `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
      )
    ).sanitizeDescriptionHtml;
  }
  const result = fn(
    '<section><p onclick="benignMarker">Text <strong>bold</strong><a href="javascript:benignMarker">link</a></p></section>',
  );
  assert.ok(!result.includes('onclick'), result);
  assert.ok(!result.includes('javascript:'), result);
  assert.ok(result.toLowerCase().includes('<strong>bold</strong>'), result);
  assert.ok(
    !fn('<a href="java&#9;script:benignMarker">link</a>').includes('href'),
    'embedded control characters must not bypass URL checks',
  );
  assert.ok(
    fn('<a href="https://example.com">safe</a>').includes(
      'href="https://example.com"',
    ),
  );
  assert.ok(!fn('<p style="position:fixed">text</p>').includes('style='));
});

test('external cover deadline includes stalled response body', async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  let streamController;
  let cleanup;
  globalThis.fetch = async (_url, { signal }) => {
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    });
    signal.addEventListener('abort', () => {
      aborted = true;
      streamController.error(new Error('deadline'));
    });
    cleanup = setTimeout(() => {
      if (!aborted) {
        streamController.enqueue(new Uint8Array([1]));
        streamController.close();
      }
    }, 100);
    return new Response(body, { headers: { 'Content-Type': 'image/png' } });
  };
  try {
    const { fetchExternalImageBuffer } = await loadSource(
      'server/utils/books/external-image.ts',
    );
    await assert.rejects(
      fetchExternalImageBuffer('https://93.184.216.34/synthetic.png'),
      /deadline|fetch external image|timed out/i,
    );
    assert.equal(aborted, true);
  } finally {
    clearTimeout(cleanup);
    globalThis.fetch = originalFetch;
  }
});

test('external cover accepts a normal image and aborts rejected oversized bodies', async () => {
  const originalFetch = globalThis.fetch;
  let signal;
  try {
    const { fetchExternalImageBuffer } = await loadSource(
      'server/utils/books/external-image.ts',
    );
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'image/png' },
      });
    };
    const result = await fetchExternalImageBuffer(
      'https://93.184.216.34/synthetic.png',
    );
    assert.deepEqual([...result.bytes], [1, 2, 3]);
    assert.equal(result.contentType, 'image/png');
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
        headers: { 'Content-Type': 'image/png' },
      });
    };
    await assert.rejects(
      fetchExternalImageBuffer('https://93.184.216.34/synthetic.png'),
      (error) => error.statusCode === 413,
    );
    if (!baseline)
      assert.equal(signal.aborted, true, 'rejected requests must be aborted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('external cover cancels redirect bodies and validates the redirected image', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let canceled = false;
  try {
    const { fetchExternalImageBuffer } = await loadSource(
      'server/utils/books/external-image.ts',
    );
    globalThis.fetch = async () => {
      requests += 1;
      if (requests === 1)
        return new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { status: 302, headers: { Location: '/next.png' } },
        );
      return new Response(new Uint8Array([4]), {
        headers: { 'Content-Type': 'image/png' },
      });
    };
    const result = await fetchExternalImageBuffer(
      'https://93.184.216.34/synthetic.png',
    );
    assert.deepEqual([...result.bytes], [4]);
    assert.equal(requests, 2);
    if (!baseline) assert.equal(canceled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('book listing never runs a write backfill on its read path', async () => {
  let writes = 0;
  globalThis.reviewDb = {
    run: async () => {
      writes += 1;
    },
    select: () => {
      throw new Error('stop after checking request-side writes');
    },
  };
  const handler = (await loadSource('server/api/books/index.get.ts')).default;
  await handler({ headers: new Headers() });
  await handler({ headers: new Headers() });
  assert.equal(writes, 0, 'read requests must not backfill data');
});

test('matching cover ETag returns 304 without reading bytes, while a normal request reads once', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'delb-review-cover-'));
  const originalCwd = process.cwd();
  await mkdir(path.join(temp, 'library/book'), { recursive: true });
  await writeFile(
    path.join(temp, 'library/book/thumb.webp'),
    'synthetic-cover',
  );
  let reads = 0;
  let selection = 0;
  globalThis.reviewFs = {
    stat,
    readFile: async (...args) => {
      reads += 1;
      return readFile(...args);
    },
  };
  globalThis.reviewDb = {
    select() {
      const rows =
        selection++ % 2 === 0
          ? [{ collectionId: 'synthetic-personal' }]
          : [{ coverImagePath: 'library/book/cover.jpg' }];
      const chain = new Proxy(
        {
          then(resolve) {
            resolve(rows);
          },
        },
        {
          get(target, key) {
            return key in target ? target[key] : () => chain;
          },
        },
      );
      return chain;
    },
  };
  const handler = (await loadSource('server/api/books/[id]/cover.get.ts'))
    .default;
  let etag;
  let responseStatus = 200;
  globalThis.setHeader = (event, name, value) => {
    if (name === 'ETag') etag = value;
  };
  globalThis.setResponseStatus = (_event, value) => {
    responseStatus = value;
  };
  try {
    process.chdir(temp);
    const first = await handler({ headers: new Headers() });
    assert.equal(first.toString(), 'synthetic-cover');
    assert.equal(reads, 1);
    reads = 0;
    const result = await handler({
      headers: new Headers({ 'if-none-match': etag }),
    });
    assert.equal(result, null);
    assert.equal(responseStatus, 304);
    assert.equal(reads, 0);
  } finally {
    process.chdir(originalCwd);
    await rm(temp, { recursive: true });
  }
});
