import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchAuth } from './fetch-auth.mjs';

// Run against the disposable demo started by review/start-demo.mjs.
const base = process.env.DELB_REVIEW_URL || 'http://127.0.0.1:4317';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const chrome =
  process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(path.join(tmpdir(), 'delb-status-chrome-'));
const browser = spawn(
  chrome,
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
const results = [];
let ws;
async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw Error('Timed out: ' + label);
}
function pass(label) {
  results.push(label);
  console.log('PASS', label);
}
async function api(route, cookie, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: base,
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
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
  }, 'Chrome debugging endpoint');
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  ws = new WebSocket(
    targets.find((t) => t.type === 'page').webSocketDebuggerUrl,
  );
  await new Promise((resolve) =>
    ws.addEventListener('open', resolve, { once: true }),
  );
  let sequence = 0;
  const pending = new Map();
  const paused = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Fetch.requestPaused') paused.push(message.params);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (request)
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
      }, 20000).unref();
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
  async function click(expression, button = 'left') {
    const box = await evaluate(
      `(()=>{const el=${expression};if(!el)throw Error('Missing target');el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button,
      buttons: button === 'right' ? 2 : 1,
      clickCount: 1,
      ...box,
    });
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button,
      clickCount: 1,
      ...box,
    });
  }
  const item = (label) =>
    `[...document.querySelectorAll('[role=menuitem],[role=menuitemradio]')].find(el=>el.textContent.trim()===${JSON.stringify(label)})`;
  const cover = (title) =>
    `[...document.querySelectorAll('.cover')].find(el=>!el.closest('[aria-hidden=true]')&&el.textContent.trim()===${JSON.stringify(title)})`;
  async function openStatus(title) {
    await until(cover(title));
    await click(cover(title), 'right');
    await until(item('Reading status'));
    await click(item('Reading status'));
    await until("document.querySelectorAll('[role=menuitemradio]').length===5");
  }
  async function choose(title, label, expected, cookie, id) {
    await openStatus(title);
    await click(item(label));
    await until("!document.querySelector('[role=menu]')");
    assert.equal(
      (await api(`/api/books/${id}/status`, cookie)).data.status,
      expected,
    );
    await openStatus(title);
    assert.equal(
      await evaluate(`(${item(label)}).getAttribute('aria-checked')`),
      'true',
    );
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  }
  await call('Page.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const signup = await fetchAuth(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `book-status-${randomBytes(5).toString('hex')}@example.invalid`,
      name: 'Status Review',
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const cookie = signup.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  await call('Network.setCookies', {
    cookies: cookie.split('; ').map((pair) => ({
      name: pair.slice(0, pair.indexOf('=')),
      value: pair.slice(pair.indexOf('=') + 1),
      url: base,
    })),
  });
  const title = `Status reference ${randomBytes(3).toString('hex')}`;
  const created = await api('/api/books', cookie, {
    title,
    authors: ['Status Author'],
    pages: 200,
  });
  const id = created.data.book.id;
  async function navigate(route) {
    await call('Page.navigate', { url: base + route });
    await until('document.readyState === "complete"');
  }
  await navigate('/books');
  await openStatus(title);
  assert.equal(
    await evaluate(`(${item('No status')}).getAttribute('aria-checked')`),
    'true',
  );
  assert.ok(await evaluate(item('View')));
  assert.equal(await evaluate(item('Download')), undefined);
  await writeFile(
    'review/demo/book-status-menu.png',
    Buffer.from(
      (await call('Page.captureScreenshot', { format: 'png' })).data,
      'base64',
    ),
  );
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  pass(
    'reference-only grid cover offers all statuses, marks No status, and preserves View',
  );
  for (const [label, expected] of [
    ['To be read', 'to_be_read'],
    ['Reading', 'reading'],
    ['Finished', 'finished'],
    ['DNF', 'dnf'],
    ['No status', null],
  ]) {
    await choose(title, label, expected, cookie, id);
    const status = (await api(`/api/books/${id}/status`, cookie)).data;
    if (expected === 'reading') assert.ok(status.startedAt);
    if (expected === 'finished')
      assert.ok(status.startedAt && status.finishedAt);
    if (expected === 'dnf')
      assert.ok(status.startedAt && status.dnfAt && !status.finishedAt);
  }
  pass('all five grid status choices persist and current-choice marks refresh');
  await click('document.querySelector(\'[aria-label="List View"]\')');
  await until(
    "document.querySelector('[aria-label=\"List View\"]').getAttribute('aria-pressed')==='true'",
  );
  await choose(title, 'Reading', 'reading', cookie, id);
  pass('list cover changes status through the same API');
  await api(`/api/books/${id}/status`, cookie, { status: 'to_be_read' });
  await navigate('/books?status=to_be_read');
  await openStatus(title);
  await click(item('Finished'));
  await until(`!(${cover(title)})`);
  assert.equal(
    (await api(`/api/books/${id}/status`, cookie)).data.status,
    'finished',
  );
  pass('changing status removes the book from a mismatched filtered list');
  await navigate('/');
  await until(
    "[...document.querySelectorAll('a')].some(el=>el.textContent.includes('All books'))",
  );
  await click(
    "[...document.querySelectorAll('a')].find(el=>el.textContent.includes('All books'))",
  );
  await openStatus(title);
  await call('Fetch.enable', {
    patterns: [
      { urlPattern: `*/api/books/${id}/status`, requestStage: 'Request' },
    ],
  });
  await click(item('Reading'));
  const request = await waitFor(() => paused.shift(), 'pending status save');
  assert.equal(request.request.method, 'POST');
  assert.ok(
    await evaluate(
      "[...document.querySelectorAll('[role=status]')].some(el=>el.textContent.includes('Saving'))",
    ),
  );
  assert.equal(
    await evaluate(`(${item('Reading')}).getAttribute('aria-disabled')`),
    'true',
  );
  await call('Fetch.fulfillRequest', {
    requestId: request.requestId,
    responseCode: 500,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(
      '{"success":false,"message":"Synthetic failure"}',
    ).toString('base64'),
  });
  await until(
    "document.querySelector('[role=alert]')?.textContent.includes('Failed to save reading status')",
  );
  assert.equal(
    (await api(`/api/books/${id}/status`, cookie)).data.status,
    'finished',
  );
  await call('Fetch.disable');
  await click(item('Reading'));
  await until("!document.querySelector('[role=menu]')");
  assert.equal(
    (await api(`/api/books/${id}/status`, cookie)).data.status,
    'reading',
  );
  pass(
    'pending save disables duplicate choices; failed save stays visible and retry persists',
  );
  await navigate('/');
  await openStatus(title);
  await click(item('Finished'));
  await until(`!(${cover(title)})`);
  pass('dashboard Continue reading refreshes after status change');
  const epub = await readFile('review/demo/ordinary.epub');
  const form = new FormData();
  form.append(
    'file',
    new Blob([epub], { type: 'application/epub+zip' }),
    'ordinary.epub',
  );
  const upload = await fetch(base + '/api/books/upload', {
    method: 'POST',
    headers: { Origin: base, Cookie: cookie },
    body: form,
  });
  assert.equal(upload.status, 200);
  const uploaded = (await upload.json()).data.results.find(
    (result) => result.success,
  ).book;
  await navigate('/books');
  await openStatus(uploaded.title);
  assert.ok(await evaluate(item('Download')));
  await call('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path.join(profile, 'downloads'),
  });
  await click(item('Download'));
  await until("!document.querySelector('[role=menu]')");
  const filename = await waitFor(async () => {
    try {
      return (await readdir(path.join(profile, 'downloads'))).find((name) =>
        name.endsWith('.epub'),
      );
    } catch {
      return null;
    }
  }, 'EPUB download');
  assert.deepEqual(
    await readFile(path.join(profile, 'downloads', filename)),
    epub,
  );
  pass('existing Download action still downloads unchanged EPUB bytes');
  await call('Fetch.enable', {
    patterns: [
      {
        urlPattern: `*/api/books/${uploaded.id}/status`,
        requestStage: 'Request',
      },
    ],
  });
  await click(cover(uploaded.title), 'right');
  const unavailable = await waitFor(() => paused.shift(), 'status read');
  await call('Fetch.fulfillRequest', {
    requestId: unavailable.requestId,
    responseCode: 401,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(
      '{"success":false,"message":"Synthetic unauthorized response"}',
    ).toString('base64'),
  });
  await until(item('Reading status unavailable'));
  assert.equal(
    await evaluate(
      `(${item('Reading status unavailable')}).getAttribute('aria-disabled')`,
    ),
    'true',
  );
  assert.ok(await evaluate(item('View')));
  assert.ok(await evaluate(item('Download')));
  await call('Fetch.disable');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  pass(
    'failed status read disables that submenu while preserving View and Download',
  );
  await click(
    "[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='Select')",
  );
  await until(
    "document.querySelector('button[aria-label=\"Select book\"]') || document.body.textContent.includes('selected')",
  );
  await click(cover(uploaded.title), 'right');
  assert.equal(
    await evaluate("!!document.querySelector('[role=menu]')"),
    false,
  );
  pass('bulk selection mode keeps cover context menus disabled');
  await writeFile(
    'review/demo/book-status-results.json',
    JSON.stringify(results, null, 2) + '\n',
  );
} finally {
  ws?.close();
  browser.kill('SIGTERM');
  await new Promise((resolve) => browser.once('exit', resolve));
  await rm(profile, { recursive: true, force: true });
}
