import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@libsql/client';
import sharp from 'sharp';
import { fetchAuth } from './fetch-auth.mjs';

// Production browser measurements against the disposable synthetic demo only.
const base = process.env.DELB_REVIEW_URL || 'http://127.0.0.1:4317';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const option = (name, fallback) =>
  Number(
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ??
      fallback,
  );
const count = option('books', 800);
const artwork = option('artwork', 0);
const runs = option('runs', 3);
const latency = option('latency', 0);
const budget = option('budget', 1000);
assert.ok([count, artwork, runs, latency].every(Number.isSafeInteger));
assert.ok(count > 0 && count <= 20000 && artwork >= 0 && artwork <= count);
assert.ok(runs >= 2 && latency >= 0 && Number.isFinite(budget) && budget > 0);
assert.ok(
  !process.argv.includes('--controls') || count >= 100,
  'Controls need at least 100 books',
);
const profile = await mkdtemp(path.join(tmpdir(), 'delb-shelf-perf-chrome-'));
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
let inspectFailure;
async function waitFor(check, label) {
  for (let i = 0; i < 300; i++) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw Error('Timed out: ' + label);
}
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
try {
  const suffix = randomBytes(6).toString('hex');
  const account = (name) =>
    fetchAuth(base + '/api/auth/sign-up/email', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `shelf-perf-${name}-${suffix}@example.invalid`,
        name: `Synthetic Shelf ${name}`,
        password: randomBytes(20).toString('hex'),
      }),
    });
  // Keep the shared default's required owner separate from the measured reader.
  if (!(await db.execute('SELECT id FROM users LIMIT 1')).rows.length)
    assert.equal((await account('owner')).status, 200);
  const signup = await account('reader');
  assert.equal(signup.status, 200, await signup.clone().text());
  const { user } = await signup.json();
  const cookie = signup.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  const collectionResponse = await fetch(base + '/api/collections', {
    method: 'POST',
    headers: {
      Origin: base,
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: `Synthetic shelf ${suffix}` }),
  });
  assert.equal(
    collectionResponse.status,
    200,
    await collectionResponse.clone().text(),
  );
  const collectionId = (await collectionResponse.json()).data.collection.id;
  const memberships = await db.execute({
    sql: 'SELECT collection_id FROM collection_members WHERE user_id=? AND collection_id<>?',
    args: [user.id, collectionId],
  });
  for (const membership of memberships.rows) {
    const left = await fetch(
      base +
        `/api/collections/${encodeURIComponent(membership.collection_id)}/leave`,
      {
        method: 'POST',
        headers: { Cookie: cookie, Origin: base },
      },
    );
    assert.equal(left.status, 200, 'Synthetic reader leaves the empty default');
  }
  const author = `shelf-author-${suffix}`;
  await db.execute({
    sql: 'INSERT INTO authors(id,name,sort_name,created_at,updated_at) VALUES (?,?,?,1,1)',
    args: [author, author, author],
  });
  const image = artwork
    ? (
        await sharp({
          create: {
            width: 180,
            height: 1000,
            channels: 3,
            background: '#3d6255',
          },
        })
          .composite([
            {
              input: Buffer.from(
                '<svg width="180" height="1000"><text x="80" y="35" fill="white" font-size="25" writing-mode="vertical-rl">Synthetic book spine</text></svg>',
              ),
            },
          ])
          .webp()
          .toBuffer()
      ).toString('base64')
    : '';
  const inserts = [];
  for (let i = 0; i < count; i++) {
    const id = `shelf-perf-${suffix}-${String(i).padStart(5, '0')}`;
    const title = `Synthetic Book ${String(i).padStart(5, '0')}`;
    inserts.push({
      sql: 'INSERT INTO books(id,title,sort_title,pages,description,created_at,updated_at,created_by_user_id,collection_id) VALUES (?,?,?,?,?,1,1,?,?)',
      args: [
        id,
        title,
        title,
        120 + (i % 600),
        'Invented library metadata. '.repeat(40),
        user.id,
        collectionId,
      ],
    });
    inserts.push({
      sql: 'INSERT INTO book_authors(book_id,author_id,position) VALUES (?,?,0)',
      args: [id, author],
    });
    if (
      Math.floor(((i + 1) * artwork) / count) >
      Math.floor((i * artwork) / count)
    )
      inserts.push({
        sql: 'INSERT INTO book_spines(book_id,original_base64,original_type,image_base64,edits,revision) VALUES (?,?,?,?,?,?)',
        args: [id, image, 'image/webp', image, '{}', suffix],
      });
  }
  await db.batch(inserts, 'write');
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
  let responses = [];
  let requests = [];
  const failures = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent') {
      const { request, type } = message.params;
      const url = new URL(request.url);
      if (url.origin === base && url.pathname.startsWith('/api/'))
        requests.push({ path: url.pathname + url.search, type });
    }
    if (message.method === 'Network.responseReceived') {
      const { response, type } = message.params;
      const url = new URL(response.url);
      if (url.origin === base && url.pathname.startsWith('/api/'))
        responses.push({
          path: url.pathname + url.search,
          status: response.status,
          type,
          ttfb: response.timing
            ? response.timing.receiveHeadersEnd - response.timing.sendEnd
            : 0,
        });
    }
    if (message.method === 'Runtime.exceptionThrown')
      failures.push(message.params.exceptionDetails.text);
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
  inspectFailure = async () => ({
    text: await evaluate('document.body.innerText.slice(0,1500)'),
    failedResponses: responses.filter((response) => response.status >= 400),
    responseCount: responses.length,
    failures,
  });
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Network.setCookies', {
    cookies: cookie.split('; ').map((pair) => ({
      name: pair.slice(0, pair.indexOf('=')),
      value: pair.slice(pair.indexOf('=') + 1),
      url: base,
    })),
  });
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (latency)
    await call('Network.emulateNetworkConditions', {
      offline: false,
      latency,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    window.shelfLongTasks = [];
    new PerformanceObserver(list => window.shelfLongTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration })))).observe({type:'longtask', buffered:true});
  `,
  });
  await call('Page.navigate', { url: base + '/books' });
  await waitFor(
    () =>
      responses.some((r) => r.path === '/api/collections') &&
      evaluate(
        `document.readyState === 'complete' && !!document.querySelector('button[aria-label="Switch collection"]')`,
      ),
    'hydrated collection picker',
  );
  // Persist the normal shelf view once, then measure real page refreshes too.
  const measurements = [];
  const measure = async (kind, first) => {
    responses = [];
    requests = [];
    if (kind === 'switch') {
      await evaluate(
        `document.querySelector('button[aria-label="Grid View"]').click()`,
      );
      await waitFor(
        () => evaluate(`!document.querySelector('.bookshelf-view')`),
        'grid view',
      );
      await evaluate(
        `performance.clearResourceTimings(); window.shelfLongTasks=[]; window.shelfStart=performance.now(); document.querySelector('button[aria-label="Bookshelf View"]').click()`,
      );
    } else {
      const previousDocument = await evaluate('performance.timeOrigin');
      await call('Page.reload', { ignoreCache: first });
      await waitFor(
        () =>
          evaluate(
            `performance.timeOrigin !== ${previousDocument} && document.readyState === 'complete'`,
          ),
        'new document',
      );
    }
    await waitFor(
      () =>
        evaluate(
          `!!document.querySelector('.spine-button') && !document.querySelector('.bookshelf-view').textContent.includes('Loading your bookshelf')`,
        ),
      'usable shelf',
    );
    const timing =
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      ms: performance.now() - (${kind === 'switch' ? 'window.shelfStart' : '0'}),
      buttons: document.querySelectorAll('.spine-button').length,
      nodes: document.querySelectorAll('.bookshelf-view *').length,
      longTasks: window.shelfLongTasks,
      resources: performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/books')).map(e=>({path:new URL(e.name).pathname,duration:e.duration,start:e.startTime})),
    }))))`);
    assert.ok(timing.buttons > 0, 'Books rendered');
    assert.equal(
      responses.filter((r) => r.status >= 400).length,
      0,
      'No failed API responses',
    );
    await waitFor(
      () =>
        evaluate(`(()=>{
      const viewport=document.querySelector('.wall-viewport').getBoundingClientRect();
      return [...document.querySelectorAll('.spine-art')].filter(img=>{
        const r=img.getBoundingClientRect();return r.right>viewport.left&&r.left<viewport.right&&r.bottom>viewport.top&&r.top<viewport.bottom;
      }).every(img=>img.complete&&img.naturalWidth>0);
    })()`),
      'visible spine images',
    );
    await evaluate(`(async()=>{
      const viewport=document.querySelector('.wall-viewport').getBoundingClientRect();
      const visible=[...document.querySelectorAll('.spine-art')].filter(img=>{
        const r=img.getBoundingClientRect();return r.right>viewport.left&&r.left<viewport.right&&r.bottom>viewport.top&&r.top<viewport.bottom;
      });
      await Promise.all(visible.map(img=>img.decode()));
    })()`);
    const artworkReadyMs = await evaluate(
      `performance.now() - (${kind === 'switch' ? 'window.shelfStart' : '0'})`,
    );
    const catalogRequests = requests.filter(
      (r) => r.path.startsWith('/api/books?') && r.path.includes('sortDir=asc'),
    ).length;
    const imageRequests = requests.filter((r) => r.type === 'Image').length;
    const result = {
      kind,
      first,
      ...timing,
      artworkReadyMs,
      catalogRequests,
      imageRequests,
      responses: [...responses],
    };
    measurements.push(result);
    console.log(
      JSON.stringify({
        kind,
        first,
        ms: Math.round(timing.ms),
        buttons: timing.buttons,
        nodes: timing.nodes,
        artworkReadyMs: Math.round(artworkReadyMs),
        catalogRequests,
        imageRequests,
        longTasks: timing.longTasks,
      }),
    );
    // Confirm the real save completed before revisiting; don't measure a conflicted or pending save.
    await waitFor(async () => {
      const response = await fetch(base + '/api/bookshelf', {
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, 200);
      return (await response.json()).revision > 0;
    }, 'saved arrangement');
  };
  for (let i = 0; i < runs; i++) {
    await measure('switch', i === 0);
    await measure('reload', i === 0);
  }
  const idleFrames = await evaluate(`new Promise(resolve=>{
    const frames=[];let previous;
    requestAnimationFrame(function frame(now){if(previous)frames.push(now-previous);previous=now;
      if(frames.length<60)requestAnimationFrame(frame);else{frames.sort((a,b)=>a-b);resolve({p95:frames[57],max:frames.at(-1)})}
    });
  })`);
  await call('Performance.enable');
  const metricsBefore = (await call('Performance.getMetrics')).metrics;
  if (process.argv.includes('--profile')) {
    await call('Profiler.enable');
    await call('Profiler.start');
  }
  const beforePan = await evaluate(
    `document.querySelector('.wall').style.transform`,
  );
  await evaluate(`window.panFrames=[]; window.panRecording=true; let previous=performance.now();
    requestAnimationFrame(function frame(now){window.panFrames.push(now-previous);previous=now;if(window.panRecording)requestAnimationFrame(frame)});`);
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: 1000,
    y: 650,
    button: 'right',
    buttons: 2,
    clickCount: 1,
  });
  for (let i = 0; i < 90; i++) {
    await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 1000 - i * 8,
      y: 650 - Math.sin(i / 10) * 60,
      button: 'right',
      buttons: 2,
    });
    await delay(16);
  }
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: 288,
    y: 650,
    button: 'right',
    buttons: 0,
    clickCount: 1,
  });
  const pan = await evaluate(
    `(()=>{window.panRecording=false;const a=window.panFrames.slice(1).sort((a,b)=>a-b);return {frames:a.length,p95:a[Math.floor(a.length*.95)],max:a.at(-1),over33:a.filter(v=>v>33.5).length,transform:document.querySelector('.wall').style.transform}})()`,
  );
  assert.notEqual(
    pan.transform,
    beforePan,
    'Real pointer input moved the bookshelf camera',
  );
  const metricsAfter = (await call('Performance.getMetrics')).metrics;
  pan.cpu = Object.fromEntries(
    [
      'ScriptDuration',
      'LayoutDuration',
      'RecalcStyleDuration',
      'TaskDuration',
    ].map((name) => [
      name,
      metricsAfter.find((m) => m.name === name).value -
        metricsBefore.find((m) => m.name === name).value,
    ]),
  );
  if (process.argv.includes('--profile')) {
    const { profile: cpuProfile } = await call('Profiler.stop');
    await writeFile(
      'review/demo/bookshelf-pan.cpuprofile',
      JSON.stringify(cpuProfile),
    );
    console.log(
      JSON.stringify({
        hotFunctions: cpuProfile.nodes
          .filter((n) => n.hitCount)
          .sort((a, b) => b.hitCount - a.hitCount)
          .slice(0, 15)
          .map((n) => ({
            name: n.callFrame.functionName,
            hits: n.hitCount,
            line: n.callFrame.lineNumber,
            column: n.callFrame.columnNumber,
            url: n.callFrame.url,
          })),
      }),
    );
  }
  console.log(JSON.stringify({ idleFrames, pan }));
  if (process.argv.includes('--controls')) {
    const until = (expression) =>
      waitFor(() => evaluate(expression), expression);
    const click = (selector) =>
      evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await click('button[aria-label="Center bookshelf"]');
    await click('button[aria-label="Edit shelves"]');
    await until('document.querySelector(".bookcase-move-handle")');
    await click('.spine-button');
    await until(`document.querySelector('[aria-label="Book options"]')`);
    const height = await evaluate(
      `(()=>{const input=document.querySelector('.shelf-panel input');const before=Number(input.value);const next=before===120?121:before-1;input.value=next;input.dispatchEvent(new Event('change',{bubbles:true}));return next})()`,
    );
    await until(
      `document.querySelector('.spine-button.selected').style.height==='${height}px'`,
    );
    await click('button[aria-label="Close book options"]');
    const order = await evaluate(
      `[...document.querySelectorAll('.bookcase')].map(e=>e.dataset.bookcaseId)`,
    );
    await evaluate(`document.querySelector('.bookcase-move-handle').focus()`);
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
      `document.querySelector('.bookcase').dataset.bookcaseId===${JSON.stringify(order[1])}`,
    );
    async function resize(selector, dx, dy) {
      const before = await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).parentElement.getAttribute('style')`,
      );
      const point = await evaluate(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        buttons: 1,
        clickCount: 1,
        ...point,
      });
      await call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        button: 'left',
        buttons: 1,
        x: point.x + dx,
        y: point.y + dy,
      });
      await until(
        `document.querySelector(${JSON.stringify(selector)}).parentElement.getAttribute('style')!==${JSON.stringify(before)}`,
      );
      await call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        buttons: 0,
        clickCount: 1,
        x: point.x + dx,
        y: point.y + dy,
      });
    }
    await resize('.height-handle', 0, 18);
    await resize('.width-handle', 18, 0);
    const shelfCount = await evaluate(
      `document.querySelector('.bookcase').querySelectorAll('[data-shelf-canvas]').length`,
    );
    await click('.shelf-options');
    await until(`document.querySelector('[aria-label="Shelf options"]')`);
    await evaluate(
      `[...document.querySelectorAll('.shelf-panel button')].find(b=>b.textContent.trim()==='Add shelf').click()`,
    );
    await until(
      `document.querySelector('.bookcase').querySelectorAll('[data-shelf-canvas]').length===${shelfCount + 1}`,
    );
    await evaluate(
      `[...document.querySelector('.bookcase').querySelectorAll('.shelf-options')].at(-1).click()`,
    );
    await evaluate(
      `[...document.querySelectorAll('.shelf-panel button')].find(b=>b.textContent.trim()==='Remove this shelf').click()`,
    );
    await until(
      `document.querySelector('.bookcase').querySelectorAll('[data-shelf-canvas]').length===${shelfCount}`,
    );
    await click('button[aria-label="Done editing shelves"]');
    await evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Filters').click()`,
    );
    await until(`document.querySelector('#books-title-filter')`);
    await evaluate(
      `const titleInput=document.querySelector('#books-title-filter');titleInput.value='Synthetic Book 00000';titleInput.dispatchEvent(new Event('input',{bubbles:true}))`,
    );
    await until(
      `document.querySelectorAll('.shelf-spine:not(.dimmed)').length===1`,
    );
    await evaluate(
      `document.querySelector('#books-title-filter').value='';document.querySelector('#books-title-filter').dispatchEvent(new Event('input',{bubbles:true}))`,
    );
    await until(
      `document.querySelectorAll('.shelf-spine:not(.dimmed)').length===${count}`,
    );
    const empty = await fetch(base + '/api/collections', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Synthetic empty scope ' + suffix }),
    });
    assert.equal(empty.status, 200);
    await click('button[aria-label="Switch collection"]');
    await until(
      `[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent.includes('Synthetic empty scope ${suffix}'))`,
    );
    await evaluate(
      `[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.includes('Synthetic empty scope ${suffix}')).click()`,
    );
    await until(
      `document.querySelectorAll('.shelf-spine.dimmed').length===${count}`,
    );
    await click('button[aria-label="Switch collection"]');
    await until(
      `[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent.trim()==='All')`,
    );
    await evaluate(
      `[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.trim()==='All').click()`,
    );
    await until(
      `document.querySelectorAll('.shelf-spine:not(.dimmed)').length===${count}`,
    );
    const saved = await (
      await fetch(base + '/api/bookshelf', { headers: { Cookie: cookie } })
    ).json();
    assert.equal(
      saved.arrangement.bookcases.flatMap((c) =>
        c.shelves.flatMap((s) => s.items.flatMap((i) => i.books)),
      ).length,
      count,
    );
    console.log(
      'PASS live book sizing, shelf and case resizing, keyboard case order, empty shelf add/remove, filters and collection dimming',
    );
  }
  assert.deepEqual(failures, [], 'No unhandled browser exceptions');
  const output = {
    environment: {
      count,
      artwork,
      latency,
      runs,
      node: process.version,
      build: 'production',
      viewport: '1440x900',
    },
    measurements,
    pan,
    idleFrames,
  };
  await writeFile(
    'review/demo/bookshelf-performance.json',
    JSON.stringify(output, null, 2),
  );
  const repeat = measurements.filter((m) => !m.first);
  assert.ok(
    measurements.every((m) => m.catalogRequests === Math.ceil(count / 200)),
    'Each unfiltered catalog page is fetched once',
  );
  assert.ok(
    repeat.every((m) => m.ms < budget),
    `Repeat shelf loads exceed ${budget}ms budget; see review/demo/bookshelf-performance.json`,
  );
  console.log(
    'PASS repeat shelf loading budget with successful API responses and rendered books',
  );
} catch (error) {
  if (inspectFailure && !String(error.message).includes('budget'))
    console.error(JSON.stringify(await inspectFailure()));
  throw error;
} finally {
  db.close();
  ws?.close();
  browser.kill('SIGTERM');
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once('exit', resolve),
  );
  await rm(profile, { recursive: true, force: true });
}
