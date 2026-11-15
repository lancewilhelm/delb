import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchAuth } from './fetch-auth.mjs';
const base = 'http://127.0.0.1:4317';
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const profile = await mkdtemp(
  path.join(tmpdir(), 'delb-personal-shelves-chrome-'),
);
const browser = spawn(
  process.env.CHROME_BIN ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let ws;
async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) {
    const v = await check();
    if (v) return v;
    await delay(100);
  }
  throw Error('Timed out: ' + label);
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
    targets.find((t) => t.type === 'page').webSocketDebuggerUrl,
  );
  await new Promise((resolve) =>
    ws.addEventListener('open', resolve, { once: true }),
  );
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params);
    const request = pending.get(m.id);
    if (!request) return;
    pending.delete(m.id);
    m.error ? request.reject(m.error) : request.resolve(m.result);
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
    const r = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  const until = (expression) => waitFor(() => evaluate(expression), expression);
  const clickText = (text) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.getClientRects().length && b.textContent.trim()===${JSON.stringify(text)})?.click()`,
    );
  const fill = (selector, value) =>
    evaluate(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const signup = await fetchAuth(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Shelf tester',
      email: `shelf-ui-${randomBytes(5).toString('hex')}@example.invalid`,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const cookie = signup.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  const api = async (route, method = 'GET', body) => {
    const r = await fetch(`${base}${route}`, {
      method,
      headers: {
        Origin: base,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const first = (
    await api('/api/books', 'POST', {
      title: 'Shelf first book',
      authors: ['Example Writer'],
    })
  ).data.book.id;
  const second = (
    await api('/api/books', 'POST', {
      title: 'Shelf second book',
      authors: ['Other Writer'],
    })
  ).data.book.id;
  await call('Network.setCookies', {
    cookies: cookie.split('; ').map((c) => {
      const at = c.indexOf('=');
      return { name: c.slice(0, at), value: c.slice(at + 1), url: base };
    }),
  });
  await call('Page.navigate', { url: `${base}/shelves` });
  await until(
    'document.body.textContent.includes("You haven\'t made any Shelves yet")',
  );
  await clickText('Create Shelf');
  await until('!!document.querySelector(\'input[maxlength="120"]\')');
  await fill('input[maxlength="120"]', 'My favorites');
  await evaluate("document.querySelector('form').requestSubmit()");
  await until("location.pathname.startsWith('/shelves/')");
  await until(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Add books'))",
  );
  assert.ok(
    (await evaluate(
      "parseFloat(getComputedStyle(document.querySelector('h1')).fontSize)",
    )) <= 16,
    'Shelf title should be toolbar-sized',
  );
  const shelfId = await evaluate('location.pathname.split("/").pop()');
  await evaluate(
    "window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', metaKey:true, ctrlKey:true, bubbles:true}))",
  );
  await until(
    '!!document.querySelector(\'[role="dialog"][aria-label="Search library"] input\')',
  );
  const searchDialogClass = await evaluate(
    'document.querySelector(\'[role="dialog"][aria-label="Search library"]\').className',
  );
  await fill('[role="dialog"] input', 'Shelf first book');
  await until(
    'document.querySelector(\'[role="dialog"]\')?.textContent.includes("Shelf first book")',
  );
  await evaluate(
    "document.querySelector('[role=dialog] input').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))",
  );
  await until("!document.querySelector('[role=dialog]')");
  await clickText('Add books');
  await until("!!document.querySelector('[role=dialog] input[type=search]')");
  assert.equal(
    await evaluate("document.querySelector('[role=dialog]').className"),
    searchDialogClass,
  );
  await fill('[role=dialog] input[type=search]', 'Example Writer');
  await until(
    "document.querySelector('[role=dialog] [aria-label=\"Books to add\"]')?.getAttribute('aria-busy')==='false' && document.querySelectorAll('[role=dialog] input[type=checkbox]').length===1 && document.querySelector('[role=dialog]')?.textContent.includes('Shelf first book')",
  );
  await evaluate(
    "document.querySelector('[role=dialog] input[type=checkbox]').click()",
  );
  await clickText('Add 1 book');
  await until("!document.querySelector('[role=dialog]')");
  await until("document.body.textContent.includes('1 book')");
  assert.equal((await api(`/api/shelves/${shelfId}`)).books[0].id, first);
  await until('!!document.querySelector(\'[aria-label="Books view mode"]\')');
  await clickText('Filters');
  await until(
    '!!document.querySelector(\'input[placeholder="Filter by title"]\')',
  );
  await fill('input[placeholder="Filter by title"]', 'not on this shelf');
  await until("!document.body.textContent.includes('Shelf first book')");
  await fill('input[placeholder="Filter by title"]', '');
  await clickText('Filters');
  await evaluate(
    'document.querySelector(\'[aria-label="List View"]\').click()',
  );
  await until(
    "document.querySelector('[aria-label=\"List View\"]')?.getAttribute('aria-pressed')==='true'",
  );
  await evaluate(
    'document.querySelector(\'[aria-label="Bookshelf View"]\').click()',
  );
  await until("!!document.querySelector('.spine-button')");
  await call('Page.navigate', { url: `${base}/books` });
  await until("document.body.textContent.includes('Shelf first book')");
  await evaluate(
    'document.querySelector(\'[aria-label="Grid View"]\').click()',
  );
  await clickText('Select');
  await until('!!document.querySelector(\'[aria-label="Select book"]\')');
  await evaluate(
    '[...document.querySelectorAll(\'[aria-label="Select book"]\')].find(b=>b.closest(".relative")?.parentElement?.textContent.includes("Shelf second book")).click()',
  );
  await until(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Actions')",
  );
  await clickText('Actions');
  await clickText('Add to Shelf');
  await until(
    "[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent.trim()==='Add books' && !b.disabled)",
  );
  await clickText('Add books');
  await until("document.body.textContent.includes('to your Shelf')");
  const final = await api(`/api/shelves/${shelfId}`);
  assert.deepEqual(
    new Set(final.books.map((book) => book.id)),
    new Set([first, second]),
  );
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log(
    'PASS personal Shelves create, search picker, list and visual views, Books action',
  );
} finally {
  ws?.close();
  browser.kill('SIGTERM');
  await new Promise((resolve) => browser.once('exit', resolve));
  await rm(profile, { recursive: true, force: true });
}
