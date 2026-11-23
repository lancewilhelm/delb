import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchAuth } from './fetch-auth.mjs';
import sharp from './test-image.mjs';
const base = (
  process.env.DELB_REVIEW_URL ||
  process.env.BASE_URL ||
  'http://127.0.0.1:4317'
).replace(/\/$/, '');
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const profile = await mkdtemp(
  path.join(tmpdir(), 'delb-spine-generation-chrome-'),
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
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const signup = await fetchAuth(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Spine tester',
      email: `spine-ui-${randomBytes(5).toString('hex')}@example.invalid`,
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
  const id = (
    await api('/api/books', 'POST', {
      title: 'Synthetic book',
      authors: ['Example Writer'],
      seriesName: 'Visual reference series',
      seriesIndex: 1,
    })
  ).data.book.id;
  const image = await sharp({
    create: { width: 100, height: 150, channels: 3, background: '#ad5734' },
  })
    .png()
    .toBuffer();
  for (let i = 0; i < 16; i++) {
    const reference = (
      await api('/api/books', 'POST', {
        title: `Reference volume ${i + 1}`,
        authors: ['Example Writer'],
        seriesName: 'Visual reference series',
        seriesIndex: i + 2,
      })
    ).data.book.id;
    const form = new FormData();
    form.append('file', new Blob([image], { type: 'image/png' }), 'spine.png');
    form.append('revision', '');
    form.append(
      'edits',
      JSON.stringify({ left: 0, right: 0, top: 0, bottom: 0, stretch: false }),
    );
    const result = await fetch(`${base}/api/books/${reference}/spine`, {
      method: 'POST',
      headers: { Origin: base, Cookie: cookie },
      body: form,
    });
    assert.equal(result.status, 200, await result.clone().text());
  }
  const cover = new FormData();
  cover.append('file', new Blob([image], { type: 'image/png' }), 'cover.png');
  let response = await fetch(`${base}/api/books/${id}/cover`, {
    method: 'POST',
    headers: { Origin: base, Cookie: cookie },
    body: cover,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const challenge = await api('/api/settings/admin/chatgpt-image', 'POST', {
    action: 'start',
  });
  await delay(3100);
  assert.equal(
    (
      await api('/api/settings/admin/chatgpt-image', 'POST', {
        action: 'poll',
        attemptId: challenge.attemptId,
      })
    ).connected,
    true,
  );
  await call('Network.setCookies', {
    cookies: cookie.split('; ').map((c) => {
      const at = c.indexOf('=');
      return { name: c.slice(0, at), value: c.slice(at + 1), url: base };
    }),
  });
  await call('Page.navigate', { url: `${base}/settings/admin/spines` });
  await until("!!document.querySelector('#spine-generation-prompt')");
  await evaluate(`(() => {
    const el = document.querySelector('#spine-generation-prompt');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(el, el.value + '\\nUse embossed lettering.');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Save prompt' && !b.disabled)",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save prompt').click()",
  );
  await until(
    "document.body.innerText.includes('Prompt saved for future generations.')",
  );
  await call('Page.reload');
  await until(
    "document.querySelector('#spine-generation-prompt')?.value.includes('Use embossed lettering.')",
  );
  await until(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Restore default')",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restore default').click()",
  );
  await until(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Save prompt' && !b.disabled)",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save prompt').click()",
  );
  await until(
    "document.body.innerText.includes('Prompt saved for future generations.')",
  );
  assert.equal(
    (await api('/api/settings/admin/spine-prompt')).prompt.includes(
      'Use embossed lettering.',
    ),
    false,
  );
  const spine = new FormData();
  spine.append('file', new Blob([image], { type: 'image/png' }), 'spine.png');
  spine.append('revision', '');
  spine.append(
    'edits',
    JSON.stringify({ left: 0, right: 0, top: 0, bottom: 0, stretch: false }),
  );
  response = await fetch(`${base}/api/books/${id}/spine`, {
    method: 'POST',
    headers: { Origin: base, Cookie: cookie },
    body: spine,
  });
  assert.equal(response.status, 200, await response.clone().text());
  await call('Page.navigate', { url: `${base}/books/${id}` });
  await until("!!document.querySelector('.detail-spine.spine-gloss img')");
  const detailGloss = await evaluate(
    "getComputedStyle(document.querySelector('.detail-spine'), '::after').backgroundImage",
  );
  assert.ok(detailGloss.includes('linear-gradient'));
  async function togglePaletteSetting(query, label) {
    await evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }))`,
    );
    await until(
      '!!document.querySelector(\'[aria-label="Command palette"][role=combobox]\')',
    );
    await evaluate(`(() => {
      const el = document.querySelector('[aria-label="Command palette"][role=combobox]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(query)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(
      `[...document.querySelectorAll('.command-palette-option')].some(el => el.textContent.includes(${JSON.stringify(label)}))`,
    );
    await evaluate(
      `[...document.querySelectorAll('.command-palette-option')].find(el => el.textContent.includes(${JSON.stringify(label)})).click()`,
    );
    await evaluate(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
    );
    await until("!document.querySelector('.command-palette')");
  }
  await togglePaletteSetting('grayscale', 'grayscale filter');
  await until(
    "getComputedStyle(document.querySelector('.detail-spine')).filter.includes('grayscale')",
  );
  await call('Page.navigate', { url: `${base}/books` });
  await until(
    '!!document.querySelector(\'button[aria-label="Bookshelf View"]\')',
  );
  await evaluate(
    'document.querySelector(\'button[aria-label="Bookshelf View"]\').click()',
  );
  await until(
    "!!document.querySelector('.shelf-spine.spine-gloss .spine-art')",
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.shelf-spine'), '::after').backgroundImage",
    ),
    detailGloss,
  );
  assert.ok(
    (
      await evaluate(
        "getComputedStyle(document.querySelector('.shelf-spine')).filter",
      )
    ).includes('grayscale'),
  );
  await togglePaletteSetting('spine gloss', 'spine gloss');
  await until("!document.querySelector('.shelf-spine.spine-gloss')");
  assert.ok(
    (
      await evaluate(
        "getComputedStyle(document.querySelector('.shelf-spine')).filter",
      )
    ).includes('grayscale'),
  );
  await call('Page.navigate', { url: `${base}/books/${id}/edit` });
  await delay(500);
  if (await evaluate("document.body.innerText.includes('Server Error')"))
    throw Error('Editor returned a server error');
  await until(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Edit spine')",
  );
  await until("!!document.querySelector('.edit-spine-preview img')");
  assert.equal(
    await evaluate(
      "document.querySelector('.edit-spine-preview').classList.contains('spine-gloss')",
    ),
    false,
    'the edit-page spine respects the disabled gloss setting',
  );
  await togglePaletteSetting('spine gloss', 'spine gloss');
  await until("!!document.querySelector('.edit-spine-preview.spine-gloss')");
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.edit-spine-preview'), '::after').backgroundImage",
    ),
    detailGloss,
    'the edit-page spine uses the same gloss as book details',
  );
  await evaluate(
    "(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit spine'); button.focus(); button.click(); })()",
  );
  await until(
    "!!document.querySelector('[role=dialog][aria-label], [role=dialog][aria-labelledby]')",
  );
  await until(
    "document.querySelectorAll('.series-reference input').length === 16",
  );
  const references = await evaluate(`(() => {
    const list = document.querySelector('.series-reference-list');
    const cards = [...list.querySelectorAll('.series-reference')];
    const first = cards[0].getBoundingClientRect();
    const next = cards[1].getBoundingClientRect();
    const input = cards[0].querySelector('input').getBoundingClientRect();
    const image = cards[0].querySelector('img').getBoundingClientRect();
    return { checked: cards.filter(c => c.querySelector('input').checked).length,
      disabled: cards.filter(c => c.querySelector('input').disabled).length,
      scrolls: list.scrollWidth > list.clientWidth,
      horizontal: next.left > first.left && next.top === first.top,
      checkboxBelow: input.top >= image.bottom };
  })()`);
  assert.deepEqual(references, {
    checked: 15,
    disabled: 1,
    scrolls: true,
    horizontal: true,
    checkboxBelow: true,
  });
  const layout = await evaluate(`(() => {
    const preview = document.querySelector('.spine-preview-column').getBoundingClientRect();
    const controls = document.querySelector('.spine-control-column').getBoundingClientRect();
    return { previewRight: preview.right, controlsLeft: controls.left };
  })()`);
  assert.ok(
    layout.previewRight <= layout.controlsLeft,
    'preview sits to the left of controls',
  );
  assert.ok(
    await evaluate(
      "document.querySelector('.spine-editor').getBoundingClientRect().height >= Math.min(700, innerHeight - 64)",
    ),
    'the modal gives the spine more vertical space',
  );
  try {
    await until(
      "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Generate preview' && !b.disabled)",
    );
  } catch (error) {
    console.log(
      'Editor state:',
      await evaluate(
        '({path: location.pathname, text: document.body.innerText.slice(0, 2500)})',
      ),
    );
    throw error;
  }
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Remove').click()",
  );
  await until("!document.querySelector('.edit-spine-preview img')");
  assert.equal(
    await evaluate(
      "document.querySelector('.edit-spine-preview').classList.contains('spine-gloss')",
    ),
    false,
  );
  assert.ok(
    await evaluate(
      "document.querySelector('.edit-spine-preview').textContent.trim().length > 0",
    ),
    'the cover shows a placeholder for a removed spine',
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Undo changes').click()",
  );
  await until("!!document.querySelector('.edit-spine-preview img')");
  assert.equal(
    await evaluate(
      "document.querySelector('.edit-spine-preview').classList.contains('spine-gloss')",
    ),
    true,
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Crop image').click()",
  );
  await until("!!document.querySelector('.crop-canvas')");
  const handles = await evaluate(`(() => {
    const selection = document.querySelector('.crop-selection').getBoundingClientRect();
    const left = document.querySelector('[aria-label="Drag left crop handle"]');
    const corner = document.querySelector('[aria-label="Drag top-left crop handle"]');
    const leftRect = left.getBoundingClientRect();
    const cornerStyle = getComputedStyle(corner, '::before');
    return {
      outside: leftRect.left < selection.left,
      leftHit: document.elementFromPoint(leftRect.left + leftRect.width / 2, leftRect.top + leftRect.height / 2) === left,
      leftBar: getComputedStyle(left, '::before').backgroundColor,
      cornerTop: cornerStyle.borderTopWidth,
      cornerLeft: cornerStyle.borderLeftWidth,
    };
  })()`);
  assert.ok(
    handles.outside && handles.leftHit,
    'crop handles extend beyond the image and remain draggable',
  );
  assert.equal(handles.leftBar, 'rgb(255, 255, 255)');
  assert.equal(handles.cornerTop, '3px');
  assert.equal(handles.cornerLeft, '3px');
  const previewBounds = await evaluate(`(() => {
    const stage = document.querySelector('.preview-stage').getBoundingClientRect();
    const viewport = document.querySelector('.preview-viewport').getBoundingClientRect();
    const column = document.querySelector('.spine-preview-column').getBoundingClientRect();
    return { stageHeight: stage.height, viewportHeight: viewport.height, remaining: column.bottom - stage.bottom };
  })()`);
  assert.ok(
    previewBounds.remaining < 65,
    'preview fills the available height above its tools',
  );
  await evaluate(
    `(() => { const button = document.querySelector('[aria-label="Zoom out"]'); for (let i = 0; i < 30; i++) button.click(); })()`,
  );
  const smallBounds = await evaluate(
    `({ stage: document.querySelector('.preview-stage').getBoundingClientRect().height, viewport: document.querySelector('.preview-viewport').getBoundingClientRect().height })`,
  );
  await evaluate(
    `(() => { const button = document.querySelector('[aria-label="Zoom in"]'); for (let i = 0; i < 40; i++) button.click(); })()`,
  );
  const largeBounds = await evaluate(
    `(() => { const viewport = document.querySelector('.preview-viewport'); return { stage: document.querySelector('.preview-stage').getBoundingClientRect().height, viewport: viewport.getBoundingClientRect().height, scrollHeight: viewport.scrollHeight }; })()`,
  );
  assert.equal(
    smallBounds.stage,
    previewBounds.stageHeight,
    'zooming out keeps the preview window height',
  );
  assert.equal(
    largeBounds.stage,
    previewBounds.stageHeight,
    'zooming in keeps the preview window height',
  );
  assert.equal(smallBounds.viewport, previewBounds.viewportHeight);
  assert.equal(largeBounds.viewport, previewBounds.viewportHeight);
  assert.ok(
    largeBounds.scrollHeight > largeBounds.viewport,
    'a zoomed image can scroll within the preview',
  );
  const panPoint = await evaluate(`(() => {
    const viewport = document.querySelector('.preview-viewport');
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
    const rect = viewport.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.65, y: rect.top + rect.height * 0.55 };
  })()`);
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...panPoint,
    button: 'left',
    clickCount: 1,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: panPoint.x - 60,
    y: panPoint.y - 60,
    buttons: 1,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: panPoint.x - 60,
    y: panPoint.y - 60,
    button: 'left',
    clickCount: 1,
  });
  const panResult = await evaluate(
    `(() => { const el = document.querySelector('.preview-viewport'); return { left: el.scrollLeft, top: el.scrollTop, crop: document.querySelector('.crop-selection').style.left }; })()`,
  );
  assert.ok(
    panResult.left > 0 && panResult.top > 0,
    'dragging pans in both directions',
  );
  assert.equal(panResult.crop, '0%', 'panning does not alter the crop');
  await evaluate(
    'document.querySelector(\'[aria-label="Reset zoom"]\').click()',
  );
  const initialWidth = await evaluate(
    "document.querySelector('.crop-canvas').getBoundingClientRect().width",
  );
  const wheelPoint = await evaluate(`(() => {
    const rect = document.querySelector('.preview-viewport').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 100) };
  })()`);
  await call('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...wheelPoint,
    deltaX: 0,
    deltaY: -100,
  });
  const wheelWidth = await evaluate(
    "document.querySelector('.crop-canvas').getBoundingClientRect().width",
  );
  assert.ok(
    wheelWidth > initialWidth,
    'scrolling up over the preview zooms in',
  );
  await call('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...wheelPoint,
    deltaX: 0,
    deltaY: 100,
  });
  const wheelOutWidth = await evaluate(
    "document.querySelector('.crop-canvas').getBoundingClientRect().width",
  );
  assert.ok(
    wheelOutWidth < wheelWidth,
    'scrolling down over the preview zooms out',
  );
  assert.equal(
    await evaluate("document.querySelector('.crop-selection').style.left"),
    '0%',
    'wheel zoom leaves the crop unchanged',
  );
  await evaluate(
    'document.querySelector(\'[aria-label="Reset zoom"]\').click()',
  );
  await evaluate('document.querySelector(\'[aria-label="Zoom in"]\').click()');
  const zoomedWidth = await evaluate(
    "document.querySelector('.crop-canvas').getBoundingClientRect().width",
  );
  assert.ok(
    zoomedWidth > initialWidth,
    'zoom enlarges the image without changing its crop',
  );
  assert.equal(
    await evaluate("document.querySelector('.crop-selection').style.left"),
    '0%',
  );
  assert.equal(
    await evaluate("!!document.querySelector('.crop-control')"),
    false,
  );
  await evaluate(
    "document.querySelector('[aria-label=\"Drag left crop handle\"]').scrollIntoView({block:'center', inline:'center'})",
  );
  const handle = await evaluate(`(() => {
    const canvas = document.querySelector('.crop-canvas').getBoundingClientRect();
    const grip = document.querySelector('[aria-label="Drag left crop handle"]').getBoundingClientRect();
    return { x: Math.max(canvas.left + 4, grip.left + grip.width / 2), y: grip.top + grip.height / 2, distance: canvas.width * 0.15 };
  })()`);
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: handle.x,
    y: handle.y,
    button: 'left',
    clickCount: 1,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: handle.x + handle.distance,
    y: handle.y,
    buttons: 1,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: handle.x + handle.distance,
    y: handle.y,
    button: 'left',
    clickCount: 1,
  });
  let croppedLeft = Number(
    (
      await evaluate("document.querySelector('.crop-selection').style.left")
    ).replace('%', ''),
  );
  assert.ok(
    croppedLeft >= 10 && croppedLeft <= 20,
    `dragging a handle updates the crop: ${croppedLeft}%`,
  );
  await evaluate(
    'document.querySelector(\'[aria-label="Drag left crop handle"]\').focus()',
  );
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  });
  const keyboardCrop = Number(
    (
      await evaluate("document.querySelector('.crop-selection').style.left")
    ).replace('%', ''),
  );
  assert.equal(
    keyboardCrop,
    Math.round((croppedLeft + 0.1) * 10) / 10,
    'arrow key makes a fine crop adjustment',
  );
  croppedLeft = keyboardCrop;
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Done cropping').click()",
  );
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await until(
    "!document.querySelector('[role=dialog][aria-labelledby=spine-dialog-title]')",
  );
  assert.equal(
    await evaluate('document.activeElement.textContent.trim()'),
    'Edit spine',
  );
  assert.ok(
    await evaluate(
      "parseFloat(document.querySelector('.edit-spine-preview img').style.left) < 0",
    ),
    'cover-side preview reflects the staged crop',
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit spine').click()",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Crop image').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('.crop-selection').style.left"),
    `${croppedLeft}%`,
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Done').click()",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click()",
  );
  await waitFor(
    async () =>
      (await api(`/api/books/${id}/spine?variant=metadata`)).edits.left ===
      croppedLeft,
    'saved dragged crop',
  );
  await call('Page.navigate', { url: `${base}/books/${id}/edit` });
  await until(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Edit spine')",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit spine').click()",
  );
  await until(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Generate preview' && !b.disabled)",
  );
  async function startGeneration(buttonText, prompt) {
    await evaluate(`(() => {
      const el = document.querySelector('.generation-label textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(prompt)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(buttonText)});
      button.scrollIntoView({ block: 'center' });
      button.click();
    })()`);
    await until("!!document.querySelector('.generation-overlay[role=status]')");
    const state = await evaluate(`(() => {
      const overlay = document.querySelector('.generation-overlay[role=status]');
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Generating'));
      const candidates = [overlay?.querySelector('[aria-hidden=true]'), button?.querySelector('[aria-hidden=true]')].filter(Boolean);
      const states = candidates.map(icon => {
        const r = icon.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { top: r.top, bottom: r.bottom, visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && !!hit && (overlay.contains(hit) || button.contains(hit)) };
      });
      return { states, height: innerHeight, visible: states.some(s => s.visible) };
    })()`);
    console.log('Spinner visibility:', JSON.stringify(state));
    assert.equal(
      state.visible,
      true,
      'The spinner should be visible while using the generate button',
    );
  }
  await startGeneration('Generate preview', 'WAIT_FOR_PERMISSION');
  await until("!document.querySelector('.generation-overlay')");
  await until("document.body.innerText.includes('Deselect one to continue.')");
  assert.ok(
    await evaluate(
      "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Update preview').disabled",
    ),
  );
  await evaluate(
    "document.querySelector('.series-reference input:checked').click()",
  );
  await until(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Update preview' && !b.disabled)",
  );
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 700,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const mobileLayout = await evaluate(`(() => {
    const preview = document.querySelector('.spine-preview-column').getBoundingClientRect();
    const controls = document.querySelector('.spine-control-column').getBoundingClientRect();
    return { previewBottom: preview.bottom, controlsTop: controls.top };
  })()`);
  assert.ok(
    mobileLayout.previewBottom <= mobileLayout.controlsTop,
    'preview stacks above controls on small screens',
  );
  const mobileHeight = await evaluate(
    "document.querySelector('.preview-stage').getBoundingClientRect().height",
  );
  await evaluate(
    `(() => { const button = document.querySelector('[aria-label="Zoom in"]'); for (let i = 0; i < 40; i++) button.click(); })()`,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.preview-stage').getBoundingClientRect().height",
    ),
    mobileHeight,
    'zoom leaves the mobile preview window height unchanged',
  );
  await evaluate(
    'document.querySelector(\'[aria-label="Reset zoom"]\').click()',
  );
  await startGeneration('Update preview', 'WAIT_FOR_PERMISSION FAIL_IMAGE');
  await until("!document.querySelector('.generation-overlay')");
  await until(
    "document.querySelector('.spine-error')?.textContent.includes('usage limit')",
  );
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log(
    'PASS spine generation spinner is visible on desktop and mobile and clears on success and failure',
  );
} finally {
  ws?.close();
  browser.kill('SIGTERM');
  await new Promise((resolve) => browser.once('exit', resolve));
  await rm(profile, { recursive: true, force: true });
}
