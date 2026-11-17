import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
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
  const hydrationWarnings = [];
  let pageUrl = '';
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params);
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId)
      pageUrl = m.params.frame.url;
    if (m.method === 'Runtime.consoleAPICalled') {
      const message = m.params.args.map((arg) => arg.value ?? '').join(' ');
      if (/hydration.*mismatch/i.test(message))
        hydrationWarnings.push(`${pageUrl}: ${message}`);
    }
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
  await call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
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
  await call('Page.navigate', { url: `${base}/books/${second}` });
  await until("document.body.textContent.includes('No Shelves yet.')");
  assert.ok(
    await evaluate(
      "!![...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Create a Shelf' && a.getAttribute('href') === '/shelves')",
    ),
  );
  assert.equal(
    await evaluate(
      '!!document.querySelector(\'[aria-label="Edit my Shelves"]\')',
    ),
    false,
  );
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
  await call('Page.navigate', { url: `${base}/books/${second}` });
  await until("document.body.textContent.includes('Not on any Shelves.')");
  await evaluate(
    'document.querySelector(\'[aria-label="Edit my Shelves"]\').click()',
  );
  await until("!!document.querySelector('fieldset input[type=checkbox]')");
  await evaluate(
    "document.querySelector('fieldset input[type=checkbox]').click()",
  );
  await until(
    "document.querySelector('fieldset input[type=checkbox]')?.checked",
  );
  assert.ok(
    (await api(`/api/shelves/${shelfId}`)).books.some((b) => b.id === second),
  );
  await call('Page.reload');
  await until(`!!document.querySelector('a[href="/shelves/${shelfId}"]')`);
  await evaluate(
    'document.querySelector(\'[aria-label="Edit my Shelves"]\').click()',
  );
  await until(
    "document.querySelector('fieldset input[type=checkbox]')?.checked",
  );
  await evaluate(
    "document.querySelector('fieldset input[type=checkbox]').click()",
  );
  await until(
    "document.querySelector('fieldset input[type=checkbox]') && !document.querySelector('fieldset input[type=checkbox]').checked",
  );
  assert.ok(
    !(await api(`/api/shelves/${shelfId}`)).books.some((b) => b.id === second),
  );
  await call('Page.navigate', { url: `${base}/shelves/${shelfId}` });
  await until(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Add books'))",
  );
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
  await call('Page.navigate', { url: `${base}/shelves/${shelfId}` });
  await until('!!document.querySelector(\'[aria-label="Bookshelf View"]\')');
  await evaluate(
    'document.querySelector(\'[aria-label="Bookshelf View"]\').click()',
  );
  await until('document.querySelectorAll(".spine-button").length === 2');
  await evaluate(
    'document.querySelector(\'[aria-label="Edit shelves"]\').click()',
  );
  await until('!!document.querySelector(".shelf-action")');
  assert.equal(
    await evaluate('document.querySelectorAll(".shelf-options").length'),
    0,
    'Shelves have no menu button',
  );
  const handlePlacement = await evaluate(
    `(() => { const handle = document.querySelector('.height-handle').getBoundingClientRect(); const row = document.querySelector('[data-shelf-canvas]').getBoundingClientRect(); return { handleTop: handle.top, rowTop: row.top, left: row.left, right: row.right }; })()`,
  );
  assert.ok(
    handlePlacement.handleTop - handlePlacement.rowTop < 12,
    'Shelf height handle is at the top of the shelf',
  );
  const shelfScreenshot = Buffer.from(
    (await call('Page.captureScreenshot', { format: 'png' })).data,
    'base64',
  );
  await writeFile(
    path.join(tmpdir(), 'delb-bookshelf-polish.png'),
    shelfScreenshot,
  );
  const pixels = await sharp(shelfScreenshot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [
    ...pixels.data.subarray(
      (Math.floor(y) * pixels.info.width + Math.floor(x)) *
        pixels.info.channels,
      (Math.floor(y) * pixels.info.width + Math.floor(x)) *
        pixels.info.channels +
        3,
    ),
  ];
  assert.deepEqual(
    pixel(handlePlacement.left - 3, handlePlacement.rowTop - 3),
    pixel(handlePlacement.left - 3, handlePlacement.rowTop + 8),
    'Top left frame corner connects',
  );
  assert.deepEqual(
    pixel(handlePlacement.right + 2, handlePlacement.rowTop - 3),
    pixel(handlePlacement.right + 2, handlePlacement.rowTop + 8),
    'Top right frame corner connects',
  );
  const mouse = (type, x, y, modifiers = 0) =>
    call('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      modifiers,
      clickCount: 1,
    });
  const clickAt = async (selector) => {
    const point = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseReleased', point.x, point.y);
  };
  const dragSliderLive = async (selector, visualExpression, direction) => {
    const before = await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      const rect = input.getBoundingClientRect();
      return { left: rect.left, width: rect.width, y: rect.top + rect.height / 2, min: Number(input.min), max: Number(input.max), value: Number(input.value), visual: ${visualExpression} };
    })()`);
    const target =
      direction === 'smaller'
        ? Math.max(
            before.min,
            before.value -
              Math.max(5, Math.round((before.max - before.min) / 5)),
          )
        : Math.min(
            before.max,
            before.value +
              Math.max(5, Math.round((before.max - before.min) / 5)),
          );
    assert.notEqual(target, before.value, `${selector} has room to move`);
    const x = (value) =>
      before.left +
      9 +
      ((value - before.min) / (before.max - before.min)) * (before.width - 18);
    await mouse('mousePressed', x(before.value), before.y);
    await mouse('mouseMoved', x((target + before.value) / 2), before.y);
    const midway = await evaluate(
      `(() => ({ value: Number(document.querySelector(${JSON.stringify(selector)}).value), visual: ${visualExpression} }))()`,
    );
    assert.notEqual(
      midway.visual,
      before.visual,
      `${selector} updates while moving`,
    );
    await mouse('mouseMoved', x(target), before.y);
    const during = await evaluate(
      `(() => ({ value: Number(document.querySelector(${JSON.stringify(selector)}).value), visual: ${visualExpression} }))()`,
    );
    assert.notEqual(
      during.value,
      before.value,
      `${selector} changes while held`,
    );
    assert.notEqual(
      during.visual,
      before.visual,
      `${selector} updates the artwork before release`,
    );
    assert.notEqual(
      during.visual,
      midway.visual,
      `${selector} keeps updating while moving`,
    );
    await mouse('mouseReleased', x(target), before.y);
    await until(
      'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
    );
    return { before: before.value, after: during.value };
  };
  assert.equal(
    await evaluate(
      `document.querySelector('[aria-label="Remove shelf 1 from bookcase 1"]').disabled`,
    ),
    true,
  );
  const originalRows = (
    await api(`/api/shelves/${shelfId}`)
  ).arrangement.bookcases[0].shelves.map((shelf) => shelf.id);
  await clickAt('[aria-label="Add shelf above shelf 2 in bookcase 1"]');
  await until('document.querySelectorAll("[data-shelf-canvas]").length === 4');
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  const middleRows = (
    await api(`/api/shelves/${shelfId}`)
  ).arrangement.bookcases[0].shelves.map((shelf) => shelf.id);
  assert.deepEqual(
    [middleRows[0], middleRows[2], middleRows[3]],
    originalRows,
    'The new shelf is directly above the chosen shelf',
  );
  await clickAt('[aria-label="Remove shelf 2 from bookcase 1"]');
  await until('document.querySelectorAll("[data-shelf-canvas]").length === 3');
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  await clickAt('[aria-label="Add shelf above shelf 1 in bookcase 1"]');
  await until('document.querySelectorAll("[data-shelf-canvas]").length === 4');
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  const topRows = (
    await api(`/api/shelves/${shelfId}`)
  ).arrangement.bookcases[0].shelves.map((shelf) => shelf.id);
  assert.deepEqual(
    topRows.slice(1),
    originalRows,
    'Adding above the first shelf creates a new top shelf',
  );
  await clickAt('[aria-label="Remove shelf 1 from bookcase 1"]');
  await until('document.querySelectorAll("[data-shelf-canvas]").length === 3');
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  await evaluate(
    'document.querySelector(\'[aria-label="Center bookshelf"]\')?.click()',
  );
  await evaluate('document.querySelector(".spine-button").click()');
  await until('!!document.querySelector(\'[aria-label="Book options"]\')');
  const uprightHeight = await dragSliderLive(
    '[aria-label="Book options"] input[type=range]:nth-of-type(1)',
    'document.querySelector(".spine-button.selected").style.height',
    'smaller',
  );
  const uprightThickness = await dragSliderLive(
    '[aria-label="Book options"] label:last-child input[type=range]',
    'document.querySelector(".spine-button.selected").style.width',
    'smaller',
  );
  const selectedBookId = await evaluate(
    'document.querySelector(".spine-button.selected").dataset.bookId',
  );
  const resizedUpright = (
    await api(`/api/shelves/${shelfId}`)
  ).arrangement.bookcases
    .flatMap((bookcase) =>
      bookcase.shelves.flatMap((shelf) =>
        shelf.items.flatMap((item) => item.books),
      ),
    )
    .find((book) => book.id === selectedBookId);
  assert.equal(resizedUpright.height, uprightHeight.after);
  assert.equal(resizedUpright.width, uprightThickness.after);
  await evaluate(
    'document.querySelector(\'[aria-label="Close book options"]\').click()',
  );
  await evaluate('document.querySelector(".case-menu").open = true');
  await clickText('Add bookcase');
  await until('document.querySelectorAll(".bookcase").length === 2');
  await until(
    '!!document.querySelector(\'[aria-label="Remove empty bookcase 2"]\')',
  );
  await clickAt('[aria-label="Remove empty bookcase 2"]');
  await until('document.querySelectorAll(".bookcase").length === 1');
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  await evaluate(
    'document.querySelector(\'[aria-label="Center bookshelf"]\')?.click()',
  );
  const positions = await evaluate(`(() => {
    const books = [...document.querySelectorAll('.spine-button')].map(el => el.getBoundingClientRect());
    const row = document.querySelectorAll('[data-shelf-canvas]')[1].getBoundingClientRect();
    return { left: Math.min(...books.map(b => b.left)), right: Math.max(...books.map(b => b.right)), top: Math.min(...books.map(b => b.top)), bottom: Math.max(...books.map(b => b.bottom)), targetY: row.bottom - 70 };
  })()`);
  const wallTopBeforeSelection = await evaluate(
    'document.querySelector(".wall-viewport").getBoundingClientRect().top',
  );
  await mouse('mousePressed', positions.left - 3, positions.top - 3, 2);
  await mouse('mouseMoved', positions.right + 3, positions.bottom + 3, 2);
  await until(
    'document.querySelectorAll(".spine-button.selected").length === 2',
  );
  assert.equal(
    await evaluate(
      '!![...document.querySelectorAll(".stack-hint button")].find(button => button.textContent.includes("selected"))',
    ),
    false,
  );
  assert.equal(
    await evaluate(
      'document.querySelector(".wall-viewport").getBoundingClientRect().top',
    ),
    wallTopBeforeSelection,
  );
  await mouse('mouseReleased', positions.right + 3, positions.bottom + 3, 2);
  await until(
    'document.querySelectorAll(".spine-button.selected").length === 2',
  );
  await mouse('mousePressed', positions.left - 12, positions.top - 3, 2);
  await mouse('mouseMoved', positions.left - 8, positions.top + 1, 2);
  await until(
    'document.querySelectorAll(".spine-button.selected").length === 0',
  );
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    modifiers: 2,
  });
  await mouse('mouseReleased', positions.left - 8, positions.top + 1, 2);
  await until(
    'document.querySelectorAll(".spine-button.selected").length === 2',
  );
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
  });
  await until(
    'document.querySelectorAll(".spine-button.selected").length === 0',
  );
  await mouse('mousePressed', positions.left - 3, positions.top - 3, 2);
  await mouse('mouseMoved', positions.right + 3, positions.bottom + 3, 2);
  await mouse('mouseReleased', positions.right + 3, positions.bottom + 3, 2);
  await until(
    'document.querySelectorAll(".spine-button.selected").length === 2',
  );
  await mouse('mousePressed', positions.left + 10, positions.targetY);
  await mouse('mouseReleased', positions.left + 10, positions.targetY);
  await until(
    'document.querySelectorAll(".spine-button.selected").length === 0',
  );
  await evaluate('document.querySelector(".wall-viewport").focus()');
  for (const key of ['Space', 'Escape']) {
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: key === 'Space' ? ' ' : key,
      code: key,
    });
    assert.equal(
      await evaluate(
        'getComputedStyle(document.querySelector(".wall-viewport")).outlineStyle',
      ),
      'none',
    );
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: key === 'Space' ? ' ' : key,
      code: key,
    });
  }
  assert.ok(
    await evaluate(
      'document.querySelector(\'[aria-label="Add picture"]\')?.children.length === 1',
    ),
  );
  await mouse('mousePressed', positions.left - 3, positions.top - 3, 2);
  await mouse('mouseMoved', positions.right + 3, positions.bottom + 3, 2);
  await until(
    'document.querySelectorAll(".spine-button.selected").length === 2',
  );
  await mouse('mouseReleased', positions.right + 3, positions.bottom + 3, 2);
  const from = await evaluate(
    `(() => { const r = document.querySelector('.spine-button.selected').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  await mouse('mousePressed', from.x, from.y);
  await mouse('mouseMoved', from.x, positions.targetY);
  await mouse('mouseReleased', from.x, positions.targetY);
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  const moved = await api(`/api/shelves/${shelfId}`);
  assert.equal(moved.arrangement.bookcases[0].shelves[1].items.length, 2);
  const resizeStart = await evaluate(`(() => {
    const handle = document.querySelector('.height-handle').getBoundingClientRect();
    const shelf = document.querySelector('[data-shelf-canvas]').getBoundingClientRect();
    return { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2, top: shelf.top, bottom: shelf.bottom, height: shelf.height };
  })()`);
  await mouse('mousePressed', resizeStart.x, resizeStart.y);
  await mouse('mouseMoved', resizeStart.x, resizeStart.y - 20);
  await until(
    `document.querySelector('[data-shelf-canvas]').getBoundingClientRect().height > ${resizeStart.height}`,
  );
  const resizedShelf = await evaluate(
    `(() => { const rect = document.querySelector('[data-shelf-canvas]').getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; })()`,
  );
  assert.ok(
    resizedShelf.top < resizeStart.top,
    'Dragging the top upward increases shelf height',
  );
  assert.ok(
    Math.abs(resizedShelf.bottom - resizeStart.bottom) < 1,
    'Shelf bottom remains fixed while resizing',
  );
  await mouse('mouseReleased', resizeStart.x, resizeStart.y - 20);
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  const cancelResizeStart = await evaluate(
    `(() => { const handle = document.querySelector('.height-handle').getBoundingClientRect(); const shelf = document.querySelector('[data-shelf-canvas]').getBoundingClientRect(); return { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2, top: shelf.top, bottom: shelf.bottom, height: shelf.height }; })()`,
  );
  await mouse('mousePressed', cancelResizeStart.x, cancelResizeStart.y);
  await mouse('mouseMoved', cancelResizeStart.x, cancelResizeStart.y - 12);
  await until(
    `document.querySelector('[data-shelf-canvas]').getBoundingClientRect().height > ${cancelResizeStart.height}`,
  );
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
  });
  await mouse('mouseReleased', cancelResizeStart.x, cancelResizeStart.y - 12);
  const afterCancelResize = await evaluate(
    `(() => { const rect = document.querySelector('[data-shelf-canvas]').getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; })()`,
  );
  assert.ok(
    Math.abs(afterCancelResize.top - cancelResizeStart.top) < 1 &&
      Math.abs(afterCancelResize.bottom - cancelResizeStart.bottom) < 1,
    'Cancel restores shelf and camera position',
  );
  const beforeKeyboardResize = await evaluate(
    'document.querySelector(".height-handle").closest(".shelf-control-viewport").getBoundingClientRect().height',
  );
  await evaluate('document.querySelector(".height-handle").focus()');
  const bottomBeforeKeyboardResize = await evaluate(
    'document.querySelector("[data-shelf-canvas]").getBoundingClientRect().bottom',
  );
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowUp',
    code: 'ArrowUp',
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowUp',
    code: 'ArrowUp',
  });
  await until(
    `document.querySelector(".height-handle").closest(".shelf-control-viewport").getBoundingClientRect().height > ${beforeKeyboardResize}`,
  );
  assert.ok(
    Math.abs(
      (await evaluate(
        'document.querySelector("[data-shelf-canvas]").getBoundingClientRect().bottom',
      )) - bottomBeforeKeyboardResize,
    ) < 1,
    'Keyboard resizing keeps the bottom fixed',
  );
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowDown',
    code: 'ArrowDown',
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowDown',
    code: 'ArrowDown',
  });
  const beforeKeyboardWidth = await evaluate(
    'document.querySelector(".bookcase").getBoundingClientRect().width',
  );
  await evaluate('document.querySelector(".width-handle").focus()');
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowRight',
    code: 'ArrowRight',
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowRight',
    code: 'ArrowRight',
  });
  await until(
    `document.querySelector(".bookcase").getBoundingClientRect().width > ${beforeKeyboardWidth}`,
  );
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowLeft',
    code: 'ArrowLeft',
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowLeft',
    code: 'ArrowLeft',
  });
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  const afterResize = await api(`/api/shelves/${shelfId}`);
  const row = afterResize.arrangement.bookcases[0].shelves[1];
  row.items = [
    { x: 2, horizontal: true, books: row.items.flatMap((item) => item.books) },
  ];
  await api(`/api/shelves/${shelfId}`, 'PUT', {
    revision: afterResize.revision,
    token: afterResize.token,
    arrangement: afterResize.arrangement,
  });
  await evaluate('window.__beforeStackReload = true');
  await call('Page.reload');
  await until('window.__beforeStackReload !== true');
  await until('document.querySelectorAll(".spine-button").length === 2');
  await evaluate(
    'document.querySelector(\'[aria-label="Edit shelves"]\').click()',
  );
  await evaluate('document.querySelector(".spine-button").click()');
  await until('!!document.querySelector(\'[aria-label="Book options"]\')');
  const bookHeight = await dragSliderLive(
    '[aria-label="Book options"] input[type=range]:nth-of-type(1)',
    'document.querySelector(".spine-button.selected").style.width',
    'smaller',
  );
  const bookThickness = await dragSliderLive(
    '[aria-label="Book options"] label:last-child input[type=range]',
    'document.querySelector(".spine-button.selected").style.height',
    'smaller',
  );
  assert.ok(
    bookHeight.after < bookHeight.before &&
      bookThickness.after < bookThickness.before,
  );
  await clickText('Right');
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  const staggered = await api(`/api/shelves/${shelfId}`);
  assert.deepEqual(
    staggered.arrangement.bookcases[0].shelves[1].items[0].books.map(
      (book) => book.offsetX,
    ),
    [5, 0],
  );
  async function dragStackTo(rowIndex) {
    const point = await evaluate(
      `(() => { const handle = document.querySelector('.stack-handle').getBoundingClientRect(); const row = document.querySelectorAll('[data-shelf-canvas]')[${rowIndex}].getBoundingClientRect(); return { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2, targetY: row.bottom - 55 }; })()`,
    );
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseMoved', point.x, point.targetY);
    await mouse('mouseReleased', point.x, point.targetY);
    await until(
      'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
    );
  }
  await dragStackTo(0);
  assert.equal(
    (await api(`/api/shelves/${shelfId}`)).arrangement.bookcases[0].shelves[0]
      .items[0].books.length,
    2,
  );
  await dragStackTo(1);
  assert.equal(
    (await api(`/api/shelves/${shelfId}`)).arrangement.bookcases[0].shelves[1]
      .items[0].books.length,
    2,
  );
  const emptyPoint = await evaluate(
    `(() => { const r = document.querySelector('[data-shelf-canvas]').getBoundingClientRect(); return { x: r.left + 40, y: r.bottom - 50 }; })()`,
  );
  await mouse('mousePressed', emptyPoint.x, emptyPoint.y);
  await mouse('mouseReleased', emptyPoint.x, emptyPoint.y);
  await until('!document.querySelector(\'[aria-label="Book options"]\')');
  await evaluate('document.querySelector(".spine-button").click()');
  await until('!!document.querySelector(\'[aria-label="Book options"]\')');
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
  });
  await until('!document.querySelector(\'[aria-label="Book options"]\')');
  const pictureFile = path.join(profile, 'decoration.png');
  await writeFile(
    pictureFile,
    await sharp({
      create: { width: 60, height: 40, channels: 4, background: '#d37e41' },
    })
      .png()
      .toBuffer(),
  );
  const documentNode = await call('DOM.getDocument');
  const fileInput = await call('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector: 'input[type=file]',
  });
  await call('DOM.setFileInputFiles', {
    nodeId: fileInput.nodeId,
    files: [pictureFile],
  });
  await until('!!document.querySelector(".shelf-picture img")');
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  const handlesAbovePicture = await evaluate(`(() => {
    const picture = document.querySelector('.shelf-picture');
    const previous = picture.getAttribute('style');
    const viewport = document.querySelector('.wall-viewport').getBoundingClientRect();
    Object.assign(picture.style, { left: '0px', top: '0px', width: viewport.width + 'px', height: viewport.height + 'px', transform: 'none' });
    const result = ['.bookcase-move-handle', '.height-handle', '.width-handle', '.stack-handle', '.shelf-action'].map(selector => {
      const button = document.querySelector(selector); const rect = button.getBoundingClientRect();
      return { selector, accessible: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === button };
    });
    picture.setAttribute('style', previous);
    return result;
  })()`);
  assert.deepEqual(
    handlesAbovePicture.filter((item) => !item.accessible),
    [],
    'Shelf controls remain above pictures',
  );
  const emptyPicturePoint = await evaluate(
    `(() => { const r = document.querySelector('[data-shelf-canvas]').getBoundingClientRect(); return { x: r.left + 15, y: r.top + 60 }; })()`,
  );
  await mouse('mousePressed', emptyPicturePoint.x, emptyPicturePoint.y);
  await mouse('mouseReleased', emptyPicturePoint.x, emptyPicturePoint.y);
  await until('!document.querySelector(\'[aria-label="Picture options"]\')');
  const pictureHit = () =>
    evaluate(
      `(() => { const picture = document.querySelector('.shelf-picture'); const r = picture.getBoundingClientRect(); for (const dx of [.25, .5, .75]) for (const dy of [.25, .5, .75]) { const x = r.left + r.width * dx, y = r.top + r.height * dy; if (document.elementFromPoint(x, y)?.closest('.shelf-picture') === picture) return { x, y }; } return null; })()`,
    );
  const selectPicturePoint = await pictureHit();
  assert.ok(
    selectPicturePoint,
    'Picture has an accessible area around the controls',
  );
  await mouse('mousePressed', selectPicturePoint.x, selectPicturePoint.y);
  await mouse('mouseReleased', selectPicturePoint.x, selectPicturePoint.y);
  await until('!!document.querySelector(\'[aria-label="Picture options"]\')');
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
  });
  await until('!document.querySelector(\'[aria-label="Picture options"]\')');
  await mouse('mousePressed', selectPicturePoint.x, selectPicturePoint.y);
  await mouse('mouseReleased', selectPicturePoint.x, selectPicturePoint.y);
  await until('!!document.querySelector(\'[aria-label="Picture options"]\')');
  const pictureSize = await dragSliderLive(
    '[aria-label="Picture options"] label:nth-of-type(1) input[type=range]',
    'document.querySelector(".shelf-picture").style.width',
    'larger',
  );
  const pictureRotation = await dragSliderLive(
    '[aria-label="Picture options"] label:nth-of-type(2) input[type=range]',
    'document.querySelector(".shelf-picture").style.transform',
    'larger',
  );
  assert.ok(
    pictureSize.after > pictureSize.before &&
      pictureRotation.after > pictureRotation.before,
  );
  const beforeDrag = await api(`/api/shelves/${shelfId}`);
  const picturePoint = await pictureHit();
  await mouse('mousePressed', picturePoint.x, picturePoint.y);
  await mouse('mouseMoved', picturePoint.x + 40, picturePoint.y - 30);
  await mouse('mouseReleased', picturePoint.x + 40, picturePoint.y - 30);
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  const afterDrag = await api(`/api/shelves/${shelfId}`);
  assert.ok(
    afterDrag.arrangement.pictures[0].x > beforeDrag.arrangement.pictures[0].x,
  );
  assert.ok(
    afterDrag.arrangement.pictures[0].y > beforeDrag.arrangement.pictures[0].y,
  );
  const canceledPoint = await pictureHit();
  await mouse('mousePressed', canceledPoint.x, canceledPoint.y);
  await mouse('mouseMoved', canceledPoint.x + 25, canceledPoint.y);
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
  });
  await mouse('mouseReleased', canceledPoint.x + 25, canceledPoint.y);
  const afterCancel = await api(`/api/shelves/${shelfId}`);
  assert.equal(
    afterCancel.arrangement.pictures[0].x,
    afterDrag.arrangement.pictures[0].x,
  );
  await evaluate(
    `(() => { const input = document.querySelector('[aria-label="Picture options"] input[type=range]'); input.value = '300'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await until(
    'document.querySelector(".shelf-picture").style.width === "300px"',
  );
  await evaluate(
    'document.querySelector(\'[aria-label="Picture options"] input[type=range]\').dispatchEvent(new Event("change", { bubbles: true }))',
  );
  await evaluate(
    `(() => { const input = document.querySelectorAll('[aria-label="Picture options"] input[type=range]')[1]; input.value = '45'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await until(
    'document.querySelector(".save-status")?.textContent.trim() === "Saved"',
  );
  const decorated = await api(`/api/shelves/${shelfId}`);
  assert.equal(decorated.arrangement.pictures[0].width, 300);
  assert.equal(decorated.arrangement.pictures[0].rotation, 45);
  const edgeCase = decorated.arrangement.bookcases[0];
  const edgeBooks = edgeCase.shelves.flatMap((shelf) =>
    shelf.items.flatMap((item) => item.books),
  );
  for (const shelf of edgeCase.shelves) shelf.items = [];
  edgeCase.shelves[0].height = edgeBooks[0].height + 14;
  edgeCase.shelves[0].items = [
    {
      x: edgeCase.width - edgeBooks[0].width - 2,
      horizontal: false,
      books: [{ ...edgeBooks[0], offsetX: 0 }],
    },
  ];
  decorated.arrangement.bookcases.push({
    id: 'edge-case',
    width: edgeCase.width,
    shelves: [
      {
        id: 'edge-row',
        height: edgeBooks[1].height + 14,
        items: [
          { x: 2, horizontal: false, books: [{ ...edgeBooks[1], offsetX: 0 }] },
        ],
      },
    ],
  });
  decorated.arrangement.bookcases.push({
    id: 'narrow-case',
    width: 120,
    shelves: [{ id: 'narrow-row', height: 245, items: [] }],
  });
  await api(`/api/shelves/${shelfId}`, 'PUT', {
    revision: decorated.revision,
    token: decorated.token,
    arrangement: decorated.arrangement,
  });
  await evaluate('window.__shelfBeforeReload = true');
  await call('Page.reload');
  await until('window.__shelfBeforeReload !== true');
  await until('document.querySelector(".shelf-picture img")?.naturalWidth > 0');
  assert.equal(
    await evaluate('document.querySelector(".shelf-picture").style.width'),
    '300px',
  );
  assert.ok(
    await evaluate(
      'document.querySelector(".shelf-picture").style.transform.includes("rotate(45deg)")',
    ),
  );
  const edges = await evaluate(`(() => {
    const rows = [document.querySelector('[data-shelf-canvas]'), document.querySelector('[data-shelf-canvas="edge-row"]')];
    return rows.map(row => { const frame = row.getBoundingClientRect(); const book = row.querySelector('.spine-button').getBoundingClientRect(); return { left: frame.left, right: frame.right, top: frame.top, bottom: frame.bottom, bookLeft: book.left, bookRight: book.right, bookTop: book.top, bookBottom: book.bottom }; });
  })()`);
  for (const edge of edges) {
    assert.ok(
      edge.bookLeft >= edge.left && edge.bookRight <= edge.right,
      'A book stays inside both side borders',
    );
    assert.ok(
      edge.bookTop >= edge.top && edge.bookBottom <= edge.bottom - 14,
      'A book stays between the top border and the shelf',
    );
  }
  assert.ok(
    edges[1].left - edges[0].right >= 9.9,
    'Neighboring bookcases leave room for their outside borders',
  );
  await evaluate(
    'document.querySelector(\'[aria-label="Edit shelves"]\').click()',
  );
  const compactControls = await evaluate(`(() => {
    const root = document.querySelector('[data-control-case-id="narrow-case"]');
    const grip = root.querySelector('.height-handle').getBoundingClientRect();
    const plus = root.querySelector('.shelf-action').getBoundingClientRect();
    return { overlaps: grip.left < plus.right && plus.left < grip.right && grip.top < plus.bottom && plus.top < grip.bottom, hitsPlus: document.elementFromPoint(plus.x + plus.width / 2, plus.y + plus.height / 2)?.closest('button') === root.querySelector('.shelf-action') };
  })()`);
  assert.equal(
    compactControls.overlaps,
    false,
    'Narrow bookcase controls do not overlap',
  );
  assert.equal(
    compactControls.hitsPlus,
    true,
    'Narrow bookcase add control is clickable',
  );
  await call('Page.navigate', { url: `${base}/settings/appearance` });
  await until('!!document.querySelector(\'[aria-label="Bookshelf color"]\')');
  await until('!!document.querySelector("#__nuxt")?.__vue_app__');
  await until(
    'document.querySelector(\'[aria-label^="Use guage_dark as fixed theme"]\')?.getAttribute("aria-pressed") === "true"',
  );
  await call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await until(
    'document.querySelector(\'[aria-label^="Use guage_light as fixed theme"]\')?.getAttribute("aria-pressed") === "true"',
  );
  await call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await until(
    'document.querySelector(\'[aria-label^="Use guage_dark as fixed theme"]\')?.getAttribute("aria-pressed") === "true"',
  );
  await evaluate(
    'document.querySelector(\'[aria-label="Bookshelf texture"] button:last-child\').click()',
  );
  await until(
    'document.querySelector(\'[aria-label="Bookshelf texture"] button:last-child\').getAttribute("aria-pressed") === "true"',
  );
  await evaluate(
    `(() => { const input = document.querySelector('[aria-label="Bookshelf color"]'); input.value = '#305a72'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await waitFor(async () => {
    const response = await api('/api/settings');
    const style = response.data.userSettings?.settings?.bookshelfStyle;
    return style?.color === '#305a72' && style?.texture === 'smooth';
  }, 'bookshelf appearance to save');
  await writeFile(
    path.join(tmpdir(), 'delb-bookshelf-settings.png'),
    Buffer.from(
      (await call('Page.captureScreenshot', { format: 'png' })).data,
      'base64',
    ),
  );
  await call('Page.navigate', { url: `${base}/shelves/${shelfId}` });
  await until('!!document.querySelector(".shelf-picture img")');
  assert.equal(
    await evaluate(
      'document.querySelector(".bookshelf-view").style.getPropertyValue("--shelf-color")',
    ),
    '#305a72',
  );
  assert.equal(
    await evaluate(
      'document.querySelector(".bookshelf-view").style.getPropertyValue("--shelf-grain")',
    ),
    'none',
  );
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  assert.deepEqual(hydrationWarnings, []);
  console.log(
    'PASS personal Shelves, selection, group move, stack offset, and picture editing',
  );
} finally {
  ws?.close();
  browser.kill('SIGTERM');
  await new Promise((resolve) => browser.once('exit', resolve));
  await rm(profile, { recursive: true, force: true });
}
