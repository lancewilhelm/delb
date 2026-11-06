import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchAuth } from './fetch-auth.mjs';
import { createClient } from '@libsql/client';

const base = process.env.DELB_REVIEW_URL || 'http://127.0.0.1:4317';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const evidence = await mkdtemp(path.join(tmpdir(), 'delb-collections-evidence-'));
const profile = await mkdtemp(path.join(tmpdir(), 'delb-collections-chrome-'));
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
  async function screenshot(name) {
    const {data}=await call('Page.captureScreenshot',{format:'png'});
    await writeFile(path.join(evidence,name+'.png'),Buffer.from(data,'base64'));
  }
  async function signup(label) {
    const email=`collection-ui-${label}-${randomBytes(5).toString('hex')}@example.invalid`,password=randomBytes(20).toString('hex');
    const response=await fetchAuth(base+'/api/auth/sign-up/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:label,email,password})});
    assert.equal(response.status,200,await response.clone().text());
    return {id:(await response.json()).user.id,email,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};
  }
  async function api(route,user,method='GET',body) {
    const response=await fetchAuth(base+route,{method,headers:{Origin:base,Cookie:user.cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal(response.status,200,await response.clone().text());return (await response.json()).data;
  }
  async function authenticate(user) {
    await call('Network.clearBrowserCookies');
    await call('Network.setCookies',{cookies:user.cookie.split('; ').map(cookie=>{const index=cookie.indexOf('=');return {name:cookie.slice(0,index),value:cookie.slice(index+1),url:base};})});
    await navigate('/books');
    await evaluate('localStorage.clear()');
    await navigate('/books');
    await until('Boolean(document.querySelector(\'[aria-label="Add book"]\'))');
  }
  const press = (text) => evaluate(`[...document.querySelectorAll('button')].find(button=>button.getClientRects().length && button.textContent.trim()===${JSON.stringify(text)})?.click()`);
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const owner=await signup('owner');
  const reader=await signup('reader');
  const source=(await api('/api/collections',owner,'POST',{name:'UI source'})).collection.id;
  const target=(await api('/api/collections',owner,'POST',{name:'UI destination'})).collection.id;
  await api(`/api/collections/${source}/members`,owner,'PUT',{email:reader.email,role:'viewer'});
  const book=(await api('/api/books',owner,'POST',{title:'UI move fixture',authors:['UI Author'],collectionIds:[source]})).book.id;
  await authenticate(owner);
  await navigate(`/books/${book}`);
  await until('Boolean(document.querySelector(\'[aria-label="Move book to another collection"]\'))');
  await click('Move book to another collection');
  await until('document.querySelector(\'[role="dialog"] select\')?.options.length>1');
  assert.equal(await evaluate(`document.querySelector('[role="dialog"] button:last-child').disabled`),true);
  await evaluate(`const select=document.querySelector('[role="dialog"] select');select.value=${JSON.stringify(target)};select.dispatchEvent(new Event('change',{bubbles:true}));const checkbox=document.querySelector('[role="dialog"] input[type="checkbox"]');checkbox.click();`);
  await until('!document.querySelector(\'[role="dialog"] button:last-child\').disabled');
  await screenshot('move-confirmation');
  await press('Move books');
  await until('!document.querySelector(\'[role="dialog"]\')');
  assert.equal((await api(`/api/books/${book}`,owner)).book.collectionId,target);
  const lost=await fetch(base+`/api/books/${book}`,{headers:{Cookie:reader.cookie}});assert.equal(lost.status,404);
  pass('confirmed Move dialog preserves the entry and revokes source-only reader access');

  await navigate('/settings/admin/collections');
  await until(`document.body.textContent.includes('UI destination') && [...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Make default')`);
  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Make default' && button.parentElement.parentElement.textContent.includes('UI destination')).click()`);
  await until(`document.body.textContent.includes('UI destination is now the default')`);
  assert.equal((await api('/api/collections',owner)).collections.find(collection=>collection.isDefault).id,target);
  pass('administrative default control updates the default designation');

  const zero=await signup('zero');
  await api(`/api/collections/${target}/leave`,zero,'POST',{});
  await authenticate(zero);
  await click('Add book');
  await until(`document.body.textContent.includes('You have no writable collections')`);
  await evaluate(`const label=[...document.querySelectorAll('label')].find(label=>label.textContent.includes('New collection name'));const input=label.querySelector('input');input.value='UI created from empty';input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await press('Create collection');
  await until(`[...document.querySelectorAll('select')].some(select=>select.selectedOptions[0]?.textContent.includes('UI created from empty'))`);
  assert.equal((await api('/api/collections',zero)).collections.length,1);
  pass('a zero-collection user creates and selects one upload destination without rejoining the default');

  await authenticate(owner);
  const db=createClient({url:'file:./review/demo/synthetic.db'});
  try {
    await db.execute('INSERT INTO legacy_collection_books(collection_id,book_id,added_by_user_id,added_at) SELECT collection_id,id,added_by_user_id,added_at FROM books');
    await db.execute({sql:'INSERT INTO legacy_collection_books(collection_id,book_id,added_at) VALUES(?,?,0)',args:[source,book]});
    await db.execute("UPDATE system_state SET value='pending' WHERE key='collections-model'");
    await navigate('/settings/admin/collections');
    await until(`[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Apply migration')`);
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Apply migration').disabled`),true);
    await evaluate(`const select=[...document.querySelectorAll('select')].find(select=>[...select.options].some(option=>option.value===${JSON.stringify(source)}));select.value=${JSON.stringify(source)};select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('input[type="checkbox"]').click();`);
    await until(`[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Apply migration' && !button.disabled)`);
    await screenshot('migration-preview');
    await press('Apply migration');
    await until(`document.body.textContent.includes('Collection migration complete.')`);
    assert.equal((await api(`/api/books/${book}`,owner)).book.collectionId,source);
    pass('migration preview requires an original-entry choice and backup confirmation before applying');
    await call('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:false});
    await screenshot('collections-admin-mobile');
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'admin collections fits the phone viewport');
    assert.deepEqual(exceptions,[],'no unhandled browser exceptions');
    pass('admin collection controls fit a phone viewport without unhandled browser exceptions');
    await writeFile(path.join(evidence,'results.json'),JSON.stringify(results,null,2));console.log('Evidence:',evidence);
  } finally {db.close();}
} finally {
  ws?.close();browser.kill('SIGTERM');await new Promise(resolve=>browser.once('exit',resolve));await rm(profile,{recursive:true,force:true});
}
