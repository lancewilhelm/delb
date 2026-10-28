import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';

const base = 'http://127.0.0.1:4317';
const accounts = JSON.parse(
  await readFile('.audit/tag-browser-account.json', 'utf8'),
);
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const fixtureDb = createClient({ url: 'file:./review/demo/synthetic.db' });
for (const [id, name] of [
  ['tag-browser-merge', 'Browser merge source'],
  ['tag-browser-target', 'Browser merge target'],
  ['tag-browser-delete', 'Browser delete fixture'],
  ['tag-percent', '%'],
  ...Array.from({ length: 8 }, (_, i) => [
    `tag-layout-${i}`,
    `Layout fixture ${i}`,
  ]),
]) {
  await fixtureDb.execute({
    sql: 'INSERT OR IGNORE INTO tags(id,name,created_at,updated_at) VALUES(?,?,1700000000,1700000000)',
    args: [id, name],
  });
  await fixtureDb.execute({
    sql: "INSERT OR IGNORE INTO book_tags(book_id,tag_id) SELECT 'tag-book-1',id FROM tags WHERE name=?",
    args: [name],
  });
}
fixtureDb.close();
const targets = await (await fetch('http://127.0.0.1:9232/json/list')).json();
const ws = new WebSocket(
  targets.find((t) => t.type === 'page').webSocketDebuggerUrl,
);
await new Promise((resolve) =>
  ws.addEventListener('open', resolve, { once: true }),
);
let seq = 0;
const pending = new Map();
const pausedResponses = [];
ws.addEventListener('message', (event) => {
  const item = JSON.parse(event.data);
  if (item.method === 'Fetch.requestPaused') pausedResponses.push(item.params);
  if (item.id) {
    const entry = pending.get(item.id);
    pending.delete(item.id);
    if (entry)
      item.error ? entry.reject(item.error) : entry.resolve(item.result);
  }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(Error(method + ' timeout'));
    }, 60000).unref();
  });
}
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails)
    throw Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await sleep(200);
  }
  throw Error('Timed out ' + expression);
}
async function navigate(path) {
  await call('Page.navigate', { url: base + path });
  await waitFor('document.readyState === "complete"');
  await sleep(500);
}
async function click(selector) {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  const box = await evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});let r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight||r.left<0||r.right>innerWidth){e.scrollIntoView({block:'center'});r=e.getBoundingClientRect();}return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...box,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...box,
  });
}
async function button(text, within = 'document') {
  const selector = await evaluate(
    `(()=>{const b=[...${within}.querySelectorAll('button')].find(b=>b.getClientRects().length && !b.hasAttribute('aria-haspopup') && b.textContent.trim()===${JSON.stringify(text)});if(!b)return null;b.dataset.tagTest=${JSON.stringify('button-' + text)};return '[data-tag-test='+JSON.stringify(b.dataset.tagTest)+']'})()`,
  );
  assert.ok(selector, 'button ' + text);
  await click(selector);
}
async function key(key, code = key, shift = false) {
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: key === 'Enter' ? '\r' : undefined,
    key,
    code,
    modifiers: shift ? 8 : 0,
    windowsVirtualKeyCode: { Escape: 27, Tab: 9, Enter: 13, ArrowDown: 40 }[
      key
    ],
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers: shift ? 8 : 0,
  });
}
async function type(selector, text) {
  await click(selector);
  await call('Input.insertText', { text });
}
async function setAccount(account) {
  await call('Network.clearBrowserCookies');
  await call('Network.setCookies', {
    cookies: account.cookie.split('; ').map((pair) => ({
      name: pair.slice(0, pair.indexOf('=')),
      value: pair.slice(pair.indexOf('=') + 1),
      url: base,
    })),
  });
}
const results = [];
function pass(check, evidence) {
  results.push({ check, evidence });
  console.log('PASS', check, JSON.stringify(evidence ?? {}));
}
await call('Page.enable');
await call('Network.enable');
await call('Fetch.disable');
await call('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await call('Storage.clearDataForOrigin', {
  origin: base,
  storageTypes: 'local_storage',
});
await setAccount(accounts.owner);
await navigate('/tags/tag-sort');
await waitFor(
  'document.body.innerText.includes("Sorting fixture") && document.body.innerText.includes("Fixture 1 delta")',
);
const sortingTrigger = 'button[aria-label="Sort books"]';
const gridOrder = () =>
  evaluate(
    `[...document.querySelectorAll('.cover')].map(e=>e.textContent.match(/Fixture (\\d+)/)?.[1]).filter(Boolean).map(Number)`,
  );
await click(sortingTrigger);
await button('Alphabetical');
await waitFor(
  `document.querySelector(${JSON.stringify(sortingTrigger)})?.textContent.includes('Alphabetical')`,
);
await sleep(400);
assert.deepEqual(await gridOrder(), [2, 3, 5, 7, 1, 6, 4]);
pass('grid alphabetical sorting matches rendered book order');
await click(sortingTrigger);
await button('Alphabetical');
await sleep(400);
assert.deepEqual(await gridOrder(), [4, 6, 1, 7, 5, 3, 2]);
pass('reselecting alphabetical reverses rendered order');
await click('[aria-label="Books view mode"] button:nth-child(2)');
await sleep(400);
await click(sortingTrigger);
await button('Pages');
await sleep(400);
assert.deepEqual(await gridOrder(), [3, 7, 1, 4, 5, 2, 6]);
pass('list pages sorting puts zero first and unknown counts last');
await navigate('/books');
await waitFor(
  `document.querySelector(${JSON.stringify(sortingTrigger)})?.textContent.includes('Pages')`,
);
pass('Books and tag detail reuse persisted sort preference');
await navigate('/tags');
await waitFor(
  `!!document.querySelector('button[aria-label="Actions for Browser delete fixture"]')`,
);
const deleteTrigger = 'button[aria-label="Actions for Browser delete fixture"]';
await click(deleteTrigger);
const menuVisibility = await evaluate(
  `(()=>{const e=[...document.querySelectorAll('[role=menu] button')].find(b=>b.getClientRects().length && !b.hasAttribute('aria-haspopup') && b.textContent.trim()==='Delete tag');const r=e.getBoundingClientRect();return {visible:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e,insideViewport:r.y>=0&&r.bottom<=innerHeight}})()`,
);
assert.ok(
  menuVisibility.visible && menuVisibility.insideViewport,
  JSON.stringify(menuVisibility),
);
await button('Delete tag');
await waitFor('!!document.querySelector("dialog[open]")');
assert.ok(
  await evaluate(
    'document.querySelector("dialog[open]").innerText.includes("across all collections")',
  ),
);
const dialogLabel = await evaluate(
  `(()=>{const d=document.querySelector('dialog[open]');return document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim()})()`,
);
assert.equal(dialogLabel, 'Delete tag');
await key('Tab');
assert.ok(
  await evaluate(
    'document.querySelector("dialog[open]").contains(document.activeElement)',
  ),
);
await key('Tab', 'Tab', true);
assert.ok(
  await evaluate(
    'document.querySelector("dialog[open]").contains(document.activeElement)',
  ),
);
await button('Cancel', 'document.querySelector("dialog[open]")');
await waitFor('!document.querySelector("dialog[open]")');
await waitFor(
  `document.activeElement?.getAttribute('aria-label') === 'Actions for Browser delete fixture'`,
);
assert.equal(
  await evaluate('document.activeElement?.getAttribute("aria-label")'),
  'Actions for Browser delete fixture',
);
pass(
  'list delete confirmation is visible, labels correctly, traps and restores focus; cancel preserves tag',
  menuVisibility,
);
await key('Enter');
await waitFor(`!!document.querySelector('[role="menu"]')`);
await key('ArrowDown');
assert.equal(
  await evaluate('document.activeElement.textContent.trim()'),
  'Delete tag',
);
await key('Enter');
await waitFor(`!!document.querySelector('dialog[open]')`);
await key('Escape');
await waitFor(
  `!document.querySelector('dialog[open]') && document.activeElement?.getAttribute('aria-label') === 'Actions for Browser delete fixture'`,
);
pass(
  'keyboard opens actions, selects delete with arrows and cancels with Escape',
);
await key('Enter');
await waitFor(`!!document.querySelector('[role="menu"]')`);
await key('End');
assert.equal(
  await evaluate('document.activeElement.textContent.trim()'),
  'Delete tag',
);
await key('Home');
assert.equal(
  await evaluate('document.activeElement.textContent.trim()'),
  'Merge tag',
);
await key('ArrowUp');
assert.equal(
  await evaluate('document.activeElement.textContent.trim()'),
  'Delete tag',
);
await key('Tab');
await waitFor(`!document.querySelector('[role="menu"]')`);
pass(
  'Home, End and ArrowUp navigate actions; Tab closes the menu on focus departure',
);
const card = await evaluate(
  `(()=>{const e=document.querySelector('a[aria-label="View Browser merge source"]');const r=e.getBoundingClientRect();return{x:r.x+20,y:r.y+20}})()`,
);
await call('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  button: 'right',
  clickCount: 1,
  ...card,
});
await call('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  button: 'right',
  clickCount: 1,
  ...card,
});
await waitFor('!!document.querySelector("[role=menu]")');
assert.equal(await evaluate('location.pathname'), '/tags');
await button('Merge tag');
await waitFor('!!document.querySelector("dialog[open]")');
assert.equal(
  await evaluate(
    `document.querySelector('dialog[open] button:last-child').disabled`,
  ),
  true,
);
await type('dialog[open] input', '%');
await waitFor(
  `!![...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent.trim()==='%')`,
);
pass('merge destination search finds a literal percent tag');
await evaluate(
  `(()=>{const input=document.querySelector('dialog[open] input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
);
await type('dialog[open] input', 'Browser merge target');
await waitFor(
  `!![...document.querySelectorAll('dialog[open] button')].find(b=>b.getClientRects().length && !b.hasAttribute('aria-haspopup') && b.textContent.trim()==='Browser merge target')`,
);
await button('Browser merge target', 'document.querySelector("dialog[open]")');
await button('Merge tag', 'document.querySelector("dialog[open]")');
await waitFor(
  `!document.querySelector('button[aria-label="Actions for Browser merge source"]') && !!document.querySelector('button[aria-label="Actions for Browser merge target"]')`,
);
pass(
  'list right-click opens merge without navigation, requires target, refreshes source away',
);
await navigate('/tags/tag-browser-delete');
await waitFor(
  `!!document.querySelector('button[aria-label="Actions for Browser delete fixture"]')`,
);
await click(deleteTrigger);
await button('Delete tag');
await waitFor('!!document.querySelector("dialog[open]")');
await writeFile(
  '.audit/tag-delete-confirmation.png',
  Buffer.from(
    (await call('Page.captureScreenshot', { format: 'png' })).data,
    'base64',
  ),
);
await button('Delete tag', 'document.querySelector("dialog[open]")');
await waitFor(
  `location.pathname === "/tags" && !document.querySelector('button[aria-label="Actions for Browser delete fixture"]')`,
);
pass('detail delete returns to refreshed tag list');
await navigate('/tags/tag-browser-target');
await waitFor(
  `!!document.querySelector('button[aria-label="Actions for Browser merge target"]')`,
);
await click('button[aria-label="Actions for Browser merge target"]');
await button('Merge tag');
await type('dialog[open] input', 'Clean tag');
await waitFor(
  `!![...document.querySelectorAll('dialog[open] button')].find(b=>b.getClientRects().length && !b.hasAttribute('aria-haspopup') && b.textContent.trim()==='Clean tag')`,
);
await button('Clean tag', 'document.querySelector("dialog[open]")');
await button('Merge tag', 'document.querySelector("dialog[open]")');
await waitFor(
  'location.pathname === "/tags/tag-target" && document.body.innerText.includes("Clean tag")',
);
pass('detail merge navigates to destination tag and loads its books');
await call('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await navigate('/tags/tag-sort');
await waitFor(`!!document.querySelector(${JSON.stringify(sortingTrigger)})`);
await click(sortingTrigger);
assert.ok(
  await evaluate(
    `document.querySelector('[role=menu]').getBoundingClientRect().x >= 0`,
  ),
);
await writeFile(
  '.audit/tag-sort-mobile.png',
  Buffer.from(
    (await call('Page.captureScreenshot', { format: 'png' })).data,
    'base64',
  ),
);
await key('Escape');
pass('mobile sort menu has a label and stays within the viewport');
await navigate('/tags');
await click('button[aria-label="Actions for Sorting fixture"]');
const bottomMenu = await evaluate(
  `(()=>{const menu=document.querySelector('[role="menu"]');const rect=menu.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,viewport:innerHeight,visible:menu.contains(document.elementFromPoint(rect.x+20,rect.y+20))}})()`,
);
assert.ok(
  bottomMenu.top >= 0 &&
    bottomMenu.bottom <= bottomMenu.viewport &&
    bottomMenu.visible,
  JSON.stringify(bottomMenu),
);
await writeFile(
  '.audit/tag-actions-mobile.png',
  Buffer.from(
    (await call('Page.captureScreenshot', { format: 'png' })).data,
    'base64',
  ),
);
await key('Escape');
pass('last-card mobile menu stays visible outside clipped cards', bottomMenu);
await navigate('/tags/tag-target');
await call('Fetch.enable', {
  patterns: [
    {
      urlPattern: '*api/tags/tag-sort/books?limit=1*',
      requestStage: 'Response',
    },
  ],
});
await evaluate(
  `document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/tags/tag-sort')`,
);
for (let i = 0; i < 100 && !pausedResponses.length; i++) await sleep(100);
assert.ok(pausedResponses.length >= 1, 'source responses are held');
await evaluate(
  `document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/tags/tag-target')`,
);
await waitFor(
  `!!document.querySelector('button[aria-label="Actions for Clean tag"]')`,
);
for (const response of pausedResponses) {
  await call('Fetch.continueResponse', { requestId: response.requestId });
}
await call('Fetch.disable');
await sleep(300);
assert.ok(
  await evaluate(
    `!!document.querySelector('button[aria-label="Actions for Clean tag"]') && !document.querySelector('button[aria-label="Actions for Sorting fixture"]')`,
  ),
);
pass(
  'late header response cannot rename the current tag or its destructive action',
);
await setAccount(accounts.member);
await navigate('/tags');
await waitFor('document.body.innerText.includes("Hidden tag")');
assert.equal(
  await evaluate(
    `document.querySelectorAll('button[aria-label^="Actions for "]').length`,
  ),
  0,
);
pass('ordinary user sees tags without administrative action controls');
assert.equal(
  await evaluate(
    `document.querySelector('a[aria-label="View Hidden tag"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`,
  ),
  true,
);
pass('ordinary users keep the native tag link context menu');
await writeFile(
  '.audit/tag-browser-results.json',
  JSON.stringify(results, null, 2),
);
ws.close();
console.log('PASS', results.length, 'browser checks');
