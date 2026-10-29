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
await fixtureDb.execute(
  "INSERT OR IGNORE INTO authors(id,name,created_at,updated_at) VALUES('sort-author','Sorting author',1700000000,1700000000)",
);
await fixtureDb.execute(
  "INSERT OR IGNORE INTO publishers(id,name,created_at,updated_at) VALUES('sort-publisher','Sorting publisher',1700000000,1700000000)",
);
await fixtureDb.execute(
  "INSERT OR IGNORE INTO book_authors(book_id,author_id,position) SELECT id,'sort-author',0 FROM books WHERE id LIKE 'tag-book-%' OR id='tag-hidden-book'",
);
await fixtureDb.execute(
  "UPDATE books SET publisher_id='sort-publisher' WHERE id LIKE 'tag-book-%' OR id='tag-hidden-book'",
);
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
    windowsVirtualKeyCode: {
      Escape: 27,
      Tab: 9,
      Enter: 13,
      ArrowDown: 40,
      ArrowUp: 38,
      Home: 36,
      End: 35,
      F10: 121,
      ContextMenu: 93,
    }[key],
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers: shift ? 8 : 0,
  });
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
const settingsHeaders = {
  Origin: base,
  Cookie: accounts.owner.cookie,
  'Content-Type': 'application/json',
};
const currentSettings = await (
  await fetch(base + '/api/settings', { headers: settingsHeaders })
).json();
const savedTheme = await fetch(base + '/api/settings/user', {
  method: 'PUT',
  headers: settingsHeaders,
  body: JSON.stringify({
    settings: {
      ...currentSettings.data?.userSettings?.settings,
      theme: 'guage',
    },
  }),
});
assert.equal(savedTheme.status, 200);
await call('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
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
async function selectSort(label) {
  await click(sortingTrigger);
  await button(label);
  await sleep(300);
}
async function expectOrder(order) {
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(await gridOrder()) === JSON.stringify(order)) return;
    await sleep(100);
  }
  assert.deepEqual(await gridOrder(), order);
}
async function contextMenu(selector, nearEdge = false) {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  const point = await evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});let r=e.getBoundingClientRect();if(r.top<80||r.bottom>innerHeight){e.scrollIntoView({block:'center'});r=e.getBoundingClientRect();}return ${nearEdge ? '{x:r.right-3,y:r.bottom-3}' : '{x:r.x+25,y:r.y+35}'};})()`,
  );
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'right',
    clickCount: 1,
    ...point,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'right',
    clickCount: 1,
    ...point,
  });
  await waitFor(`!!document.querySelector('[role="menu"]')`);
  return point;
}
async function replaceInput(selector, text) {
  await click(selector);
  await evaluate(
    `document.querySelector(${JSON.stringify(selector)}).select()`,
  );
  await call('Input.insertText', { text });
}
const preview = () =>
  evaluate(
    `(()=>{const d=document.querySelector('dialog[open]');const source=d.querySelector('[aria-label="From tag"]');const target=d.querySelector('[aria-label="To tag"]');const input=d.querySelector('input');return {source:source.lastElementChild.textContent.trim(),target:target.lastElementChild.textContent.trim(),above:target.getBoundingClientRect().bottom < input.getBoundingClientRect().top};})()`,
  );
await selectSort('Alphabetical');
await expectOrder([2, 3, 5, 7, 1, 6, 4]);
pass('tag grid alphabetical sorting matches rendered book order');
await selectSort('Alphabetical');
await expectOrder([4, 6, 1, 7, 5, 3, 2]);
pass('reselecting alphabetical reverses rendered order');
await click('[aria-label="Books view mode"] button:nth-child(2)');
await selectSort('Pages');
await expectOrder([3, 7, 1, 4, 5, 2, 6]);
pass('tag list pages sorting puts zero first and unknown counts last');
await navigate('/books');
await waitFor(
  `document.querySelector(${JSON.stringify(sortingTrigger)})?.textContent.includes('Pages')`,
);
pass('Books and tag detail reuse persisted sort preference');
for (const [kind, id, title] of [
  ['authors', 'sort-author', 'Sorting author'],
  ['publishers', 'sort-publisher', 'Sorting publisher'],
]) {
  await navigate(`/${kind}/${id}`);
  await waitFor(
    `document.body.innerText.includes(${JSON.stringify(title)}) && document.body.innerText.includes('Fixture 1 delta')`,
  );
  await click('[aria-label="Books view mode"] button:first-child');
  await selectSort('Date added');
  await selectSort('Alphabetical');
  await expectOrder([2, 3, 5, 7, 1, 6, 4]);
  pass(`${kind} grid sorts alphabetically`);
  await click('[aria-label="Books view mode"] button:nth-child(2)');
  await selectSort('Pages');
  await expectOrder([3, 7, 1, 4, 5, 2, 6]);
  pass(`${kind} list sorts by pages with unknown counts last`);
  await selectSort('Pages');
  await expectOrder([5, 4, 1, 7, 3, 6, 2]);
  pass(`${kind} list reverses page order without moving unknowns first`);
}
await navigate('/tags');
const deleteLink = 'a[aria-label="View Browser delete fixture"]';
await waitFor(`!!document.querySelector(${JSON.stringify(deleteLink)})`);
assert.equal(
  await evaluate(
    `document.querySelectorAll('button[aria-label^="Actions for "]').length`,
  ),
  0,
);
pass('tag cards have no dropdown buttons');
const point = await contextMenu(deleteLink);
const menuBounds = await evaluate(
  `(()=>{const menu=document.querySelector('[role="menu"]');const r=menu.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,visible:menu.contains(document.elementFromPoint(r.x+20,r.y+20)),aligned:[...menu.querySelectorAll('button')].every(b=>getComputedStyle(b).justifyContent==='flex-start'&&getComputedStyle(b).textAlign==='left')};})()`,
);
assert.ok(Math.abs(menuBounds.x - point.x) < 1);
assert.ok(Math.abs(menuBounds.y - point.y) < 1);
assert.ok(menuBounds.visible && menuBounds.aligned, JSON.stringify(menuBounds));
pass('right-click menu opens at pointer with left-aligned actions', menuBounds);
await button('Delete tag');
await waitFor(`!!document.querySelector('dialog[open]')`);
assert.ok(
  await evaluate(
    `document.querySelector('dialog[open]').innerText.includes('across all collections')`,
  ),
);
assert.equal(
  await evaluate(
    `(()=>{const d=document.querySelector('dialog[open]');return document.getElementById(d.getAttribute('aria-labelledby')).textContent.trim()})()`,
  ),
  'Delete tag',
);
await key('Tab');
assert.ok(
  await evaluate(
    `document.querySelector('dialog[open]').contains(document.activeElement)`,
  ),
);
await key('Tab', 'Tab', true);
assert.ok(
  await evaluate(
    `document.querySelector('dialog[open]').contains(document.activeElement)`,
  ),
);
await button('Cancel', `document.querySelector('dialog[open]')`);
await waitFor(
  `!document.querySelector('dialog[open]') && document.activeElement?.getAttribute('aria-label') === 'View Browser delete fixture'`,
);
pass('cancel preserves tag and restores focus to its card link');
await key('F10', 'F10', true);
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
  `!document.querySelector('dialog[open]') && document.activeElement?.getAttribute('aria-label') === 'View Browser delete fixture'`,
);
pass('Shift+F10 opens card actions and Escape restores link focus');
await key('ContextMenu', 'ContextMenu');
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
pass('ContextMenu key, Home, End, ArrowUp and Tab work without card buttons');
await contextMenu('a[aria-label="View Browser merge source"]');
assert.equal(await evaluate('location.pathname'), '/tags');
await button('Merge tag');
await waitFor(`!!document.querySelector('dialog[open]')`);
assert.deepEqual(await preview(), {
  source: 'Browser merge source',
  target: '',
  above: true,
});
await waitFor(
  `getComputedStyle(document.querySelector('dialog[open]')).backgroundColor !== 'rgba(0, 0, 0, 0)'`,
);
assert.equal(
  await evaluate(
    `document.querySelector('dialog[open] button:last-child').disabled`,
  ),
  true,
);
pass('merge preview shows source and empty destination above input');
await writeFile(
  '.audit/tag-merge-empty.png',
  Buffer.from(
    (await call('Page.captureScreenshot', { format: 'png' })).data,
    'base64',
  ),
);
await replaceInput('dialog[open] input', '%');
await waitFor(
  `!![...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent.trim()==='%')`,
);
assert.equal((await preview()).target, '');
pass(
  'typing a destination leaves preview empty until an existing tag is selected',
);
await replaceInput('dialog[open] input', 'Browser merge target');
await waitFor(
  `!![...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent.trim()==='Browser merge target')`,
);
await button('Browser merge target', `document.querySelector('dialog[open]')`);
assert.equal((await preview()).target, 'Browser merge target');
await replaceInput('dialog[open] input', 'Browser');
assert.equal((await preview()).target, '');
assert.equal(
  await evaluate(
    `document.querySelector('dialog[open] button:last-child').disabled`,
  ),
  true,
);
pass('editing the search clears the chosen destination and disables merge');
await replaceInput('dialog[open] input', 'Browser merge target');
await waitFor(
  `!![...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent.trim()==='Browser merge target')`,
);
await button('Browser merge target', `document.querySelector('dialog[open]')`);
await writeFile(
  '.audit/tag-merge-selected.png',
  Buffer.from(
    (await call('Page.captureScreenshot', { format: 'png' })).data,
    'base64',
  ),
);
await button('Merge tag', `document.querySelector('dialog[open]')`);
await waitFor(
  `!document.querySelector('a[aria-label="View Browser merge source"]') && !!document.querySelector('a[aria-label="View Browser merge target"]')`,
);
pass('list merge removes source and retains destination');
await navigate('/tags/tag-browser-delete');
const deleteTrigger = 'button[aria-label="Actions for Browser delete fixture"]';
await click(deleteTrigger);
await button('Delete tag');
await waitFor(`!!document.querySelector('dialog[open]')`);
await button('Delete tag', `document.querySelector('dialog[open]')`);
await waitFor(
  `location.pathname === '/tags' && !document.querySelector('a[aria-label="View Browser delete fixture"]')`,
);
pass('detail actions remain available and deletion returns to tag list');
await navigate('/tags/tag-browser-target');
await click('button[aria-label="Actions for Browser merge target"]');
await button('Merge tag');
await replaceInput('dialog[open] input', 'Clean tag');
await waitFor(
  `!![...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent.trim()==='Clean tag')`,
);
await button('Clean tag', `document.querySelector('dialog[open]')`);
await button('Merge tag', `document.querySelector('dialog[open]')`);
await waitFor(
  `location.pathname === '/tags/tag-target' && document.body.innerText.includes('Clean tag')`,
);
pass('detail merge navigates to destination tag');
await call('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await navigate('/tags/tag-sort');
await click(sortingTrigger);
assert.ok(
  await evaluate(
    `document.querySelector('[role="menu"]').getBoundingClientRect().x>=0`,
  ),
);
await key('Escape');
pass('mobile sorting stays inside viewport');
await navigate('/tags');
const edge = await contextMenu('a[aria-label="View Sorting fixture"]', true);
const edgeBounds = await evaluate(
  `(()=>{const menu=document.querySelector('[role="menu"]');const r=menu.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,visible:menu.contains(document.elementFromPoint(r.x+20,r.y+20))};})()`,
);
assert.equal(
  edgeBounds.x,
  Math.max(0, Math.min(edge.x, edgeBounds.viewportWidth - edgeBounds.width)),
);
assert.equal(
  edgeBounds.y,
  Math.max(0, Math.min(edge.y, edgeBounds.viewportHeight - edgeBounds.height)),
);
assert.ok(edgeBounds.visible);
await writeFile(
  '.audit/tag-actions-mobile.png',
  Buffer.from(
    (await call('Page.captureScreenshot', { format: 'png' })).data,
    'base64',
  ),
);
await key('Escape');
pass('pointer menu clamps at mobile viewport edges', edgeBounds);
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
assert.ok(pausedResponses.length >= 1);
await evaluate(
  `document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/tags/tag-target')`,
);
await waitFor(
  `!!document.querySelector('button[aria-label="Actions for Clean tag"]')`,
);
for (const response of pausedResponses)
  await call('Fetch.continueResponse', { requestId: response.requestId });
await call('Fetch.disable');
await sleep(300);
assert.ok(
  await evaluate(
    `!!document.querySelector('button[aria-label="Actions for Clean tag"]') && !document.querySelector('button[aria-label="Actions for Sorting fixture"]')`,
  ),
);
pass('late header response cannot relabel current tag actions');
await setAccount(accounts.member);
await navigate('/tags');
await waitFor(`document.body.innerText.includes('Hidden tag')`);
assert.equal(
  await evaluate(
    `document.querySelectorAll('button[aria-label^="Actions for "]').length`,
  ),
  0,
);
assert.equal(
  await evaluate(
    `document.querySelector('a[aria-label="View Hidden tag"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`,
  ),
  true,
);
pass('ordinary users keep native context menus and have no admin controls');
await writeFile(
  '.audit/tag-browser-results.json',
  JSON.stringify(results, null, 2),
);
ws.close();
console.log('PASS', results.length, 'browser checks');
