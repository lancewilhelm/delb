import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchAuth } from './fetch-auth.mjs';
import { createClient } from '@libsql/client';
import { pdfFixture } from './pdf-fixture.mjs';

const base = process.env.DELB_REVIEW_URL || 'http://127.0.0.1:4317';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const evidence = await mkdtemp(path.join(tmpdir(), 'delb-pdf-evidence-'));
const profile = await mkdtemp(path.join(tmpdir(), 'delb-pdf-chrome-'));
const browser = spawn(
  process.env.CHROME_BIN ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let ws;
const exceptions = [];
const results = [];
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw Error('Timed out: ' + label);
}
function pass(label) {
  results.push(label);
  console.log('PASS', label);
}
try {
  const port = await waitFor(async () => {
    try {
      return (
        await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
      ).split('\n')[0];
    } catch {
      return null;
    }
  }, 'Chrome');
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  ws = new WebSocket(
    targets.find((target) => target.type === 'page').webSocketDebuggerUrl,
  );
  await new Promise((resolve) =>
    ws.addEventListener('open', resolve, { once: true }),
  );
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown')
      exceptions.push(message.params);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error
      ? request.reject(message.error)
      : request.resolve(message.result);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(Error(method + ' timed out'));
      }, 30000).unref();
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  const until = (expression) => waitFor(() => evaluate(expression), expression);
  const control = (label) =>
    `document.querySelector('[aria-label="${label}"]')`;
  const click = (label) => evaluate(`${control(label)}.click()`);
  async function navigate(route) {
    await call('Page.navigate', { url: base + route });
    await until('document.readyState === "complete"');
  }
  const pageReady = (page) =>
    until(
      `document.querySelector('[data-pdf-page="${page}"] canvas')?.width > 100 && ${control('Page number')}.value === '${page}' && document.querySelector('[aria-busy]')?.getAttribute('aria-busy') === 'false'`,
    );
  async function screenshot(name) {
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      path.join(evidence, name + '.png'),
      Buffer.from(data, 'base64'),
    );
  }
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const response = await fetchAuth(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'PDF Browser Review',
      email: `pdf-browser-${randomBytes(5).toString('hex')}@example.invalid`,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  await call('Network.setCookies', {
    cookies: cookie.split('; ').map((pair) => ({
      name: pair.slice(0, pair.indexOf('=')),
      value: pair.slice(pair.indexOf('=') + 1),
      url: base,
    })),
  });
  async function upload(bytes, filename, type) {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type }), filename);
    const response = await fetch(base + '/api/books/upload', {
      method: 'POST',
      headers: { Origin: base, Cookie: cookie },
      body: form,
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok((await response.json()).success);
  }
  await upload(pdfFixture(), 'Browser PDF.pdf', 'application/pdf');
  await upload(
    await readFile('review/demo/ordinary.epub'),
    'ordinary.epub',
    'application/epub+zip',
  );
  await upload(
    Buffer.from('%PDF-1.4\nbroken'),
    'Broken PDF.pdf',
    'application/pdf',
  );
  const books = (
    await (
      await fetch(base + '/api/books', { headers: { Cookie: cookie } })
    ).json()
  ).data.books;
  const pdf = books.find((book) => book.title === 'Browser PDF');
  const epub = books.find((book) => book.title === 'Synthetic ordinary book');
  const broken = books.find((book) => book.title === 'Broken PDF');
  assert.ok(pdf && epub && broken, JSON.stringify(books));
  const position = async () =>
    (
      await (
        await fetch(base + `/api/books/${pdf.id}/reading-position`, {
          headers: { Cookie: cookie },
        })
      ).json()
    ).data;
  await navigate(`/books/${pdf.id}`);
  await until(control('Read book'));
  await click('Read book');
  await pageReady(1);
  assert.equal(await evaluate('globalThis.__delbPdfScriptExecuted'), undefined);
  assert.ok(
    await evaluate(
      "parseFloat(getComputedStyle(document.querySelector('h1')).fontSize) <= 24",
    ),
  );
  for (const asset of [
    'cmaps/Adobe-Japan1-UCS2.bcmap',
    'standard_fonts/LiberationSans-Regular.ttf',
    'wasm/openjpeg.wasm',
  ]) {
    assert.equal((await fetch(`${base}/pdfjs/${asset}`)).status, 200);
  }
  assert.equal(await evaluate(`${control('Previous page')}.disabled`), true);
  assert.ok(
    await evaluate(
      "(()=>{const c=document.querySelector('canvas');return c.width>100 && c.height>100 && c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data[0]<255})()",
    ),
  );
  await screenshot('desktop');
  await click('Next page');
  await pageReady(2);
  assert.ok(
    await evaluate(
      `document.querySelector('[data-pdf-page="2"] canvas').width > document.querySelector('[data-pdf-page="2"] canvas').height`,
    ),
  );
  await waitFor(
    async () => (await position()).location?.endsWith(':2'),
    'saved PDF page 2',
  );
  pass(
    'PDF upload, Read action, real portrait/landscape rendering, navigation, and server position save',
  );

  await call('Page.reload');
  await pageReady(2);
  await click('Zoom in');
  await until(`${control('Reset zoom')}.textContent.trim() === '125%'`);
  await until(
    'document.querySelector(\'[data-pdf-page="2"] canvas\').width > 100',
  );
  await click('Next page');
  await pageReady(3);
  assert.equal(await evaluate(`${control('Next page')}.disabled`), true);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft' });
  await pageReady(2);
  await evaluate(
    `${control('Page number')}.value='1'; ${control('Page number')}.dispatchEvent(new Event('change',{bubbles:true}))`,
  );
  await pageReady(1);
  await evaluate(
    `${control('Page number')}.value='1.5'; ${control('Page number')}.dispatchEvent(new Event('change',{bubbles:true}))`,
  );
  assert.equal(await evaluate(`${control('Page number')}.value`), '1');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await click('Reset zoom');
  await pageReady(1);
  await until(
    "document.querySelector('canvas').getBoundingClientRect().width <= innerWidth",
  );
  assert.equal(
    await evaluate('document.documentElement.scrollWidth <= innerWidth'),
    true,
  );
  await until(
    `(()=>{const c=document.querySelector('[data-pdf-page="1"] canvas');return c.width > 0 && c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data[0]<255})()`,
  );
  await screenshot('mobile');
  await evaluate(
    "document.querySelector('[data-pdf-page=\"2\"]').scrollIntoView({block:'start'})",
  );
  await pageReady(2);
  await waitFor(
    async () => (await position()).location?.endsWith(':2'),
    'scroll position save',
  );
  await call('Page.reload');
  await pageReady(2);
  await click('Zoom out');
  await until(`${control('Reset zoom')}.textContent.trim() === '75%'`);
  await click('Reset zoom');
  await until(`${control('Reset zoom')}.textContent.trim() === '100%'`);
  await click('Previous page');
  await pageReady(1);
  pass(
    'scrolling and saved position, reload resume, zoom controls, page entry, keyboard arrows, and phone-width fit',
  );

  await call('Fetch.enable', {
    patterns: [{ urlPattern: '*reading-position', requestStage: 'Request' }],
  });
  let failSave = true;
  const interceptor = async (event) => {
    const message = JSON.parse(event.data);
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    if (failSave && request.method === 'PUT')
      await call('Fetch.failRequest', { requestId, errorReason: 'Failed' });
    else await call('Fetch.continueRequest', { requestId });
  };
  ws.addEventListener('message', interceptor);
  await click('Next page');
  await pageReady(2);
  await until(
    "document.body.textContent.includes('Could not save your position.')",
  );
  failSave = false;
  await evaluate(
    "[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Retry save').click()",
  );
  await waitFor(
    async () => (await position()).location?.endsWith(':2'),
    'retry save',
  );
  await until(
    "!document.body.textContent.includes('Could not save your position.')",
  );
  ws.removeEventListener('message', interceptor);
  await call('Fetch.disable');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  await until(`location.pathname==='/books/${pdf.id}'`);
  pass('failed-save feedback, retry, and Escape return');

  await navigate(`/books/${broken.id}/read`);
  await until("document.body.textContent.includes('Could not open this PDF')");
  assert.ok(
    await evaluate(
      "document.querySelector('a').textContent.includes('Download PDF')",
    ),
  );
  pass('malformed PDF error retains download fallback');
  // Model the multi-format records already produced by Calibre imports.
  const db = createClient({ url: 'file:./review/demo/synthetic.db' });
  try {
    const file = (
      await db.execute({
        sql: 'SELECT relative_path FROM book_files WHERE book_id=?',
        args: [epub.id],
      })
    ).rows[0];
    const pdfPath = path.join(
      path.dirname(file.relative_path),
      'Additional PDF.pdf',
    );
    await writeFile(pdfPath, pdfFixture());
    await db.execute({
      sql: 'INSERT INTO book_files(id, book_id, format, relative_path, created_at) VALUES (?,?,?,?,0)',
      args: [randomUUID(), epub.id, 'pdf', pdfPath],
    });
  } finally {
    db.close();
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(`/books/${epub.id}`);
  await until(
    "[...document.querySelectorAll('a')].some(link=>link.textContent.trim()==='Read PDF')",
  );
  await evaluate(
    "[...document.querySelectorAll('a')].find(link=>link.textContent.trim()==='Read PDF').click()",
  );
  await pageReady(1);
  await click('Back to book');
  await until(control('Read book'));
  await click('Read book');
  await until(
    "document.querySelector('iframe')?.contentDocument?.body?.textContent.includes('Ordinary synthetic reading paragraph')",
  );
  const epubPosition = async () =>
    (
      await (
        await fetch(base + `/api/books/${epub.id}/reading-position`, {
          headers: { Cookie: cookie },
        })
      ).json()
    ).data.location;
  const firstCfi = await waitFor(async () => {
    const location = await epubPosition();
    return location?.startsWith('epubcfi(') ? location : null;
  }, 'EPUB CFI after switching from PDF');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight' });
  await waitFor(async () => {
    const location = await epubPosition();
    return location?.startsWith('epubcfi(') && location !== firstCfi;
  }, 'EPUB page navigation saves a different CFI');
  await click('Table of contents');
  await until("document.body.textContent.includes('Chapter 2')");
  await screenshot('epub');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  await until(`location.pathname==='/books/${epub.id}'`);
  pass(
    'mixed-format books offer Read PDF, prefer EPUB, ignore PDF positions in EPUB, navigate, display the TOC, and return to details',
  );
  assert.deepEqual(exceptions, [], 'no unhandled browser exceptions');
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify(results, null, 2),
  );
  console.log('Evidence:', evidence);
} finally {
  ws?.close();
  browser.kill('SIGTERM');
  await new Promise((resolve) => browser.once('exit', resolve));
  await rm(profile, { recursive: true, force: true });
}
