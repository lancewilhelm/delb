import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchAuth } from './fetch-auth.mjs';
import sharp from 'sharp';
const base = 'http://127.0.0.1:4317';
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
    })
  ).data.book.id;
  const image = await sharp({
    create: { width: 100, height: 150, channels: 3, background: '#ad5734' },
  })
    .png()
    .toBuffer();
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
  await call('Page.navigate', { url: `${base}/books/${id}/edit` });
  await delay(500);
  if (await evaluate("document.body.innerText.includes('Server Error')"))
    throw Error('Editor returned a server error');
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
  await until(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Update preview' && !b.disabled)",
  );
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 700,
    deviceScaleFactor: 1,
    mobile: true,
  });
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
