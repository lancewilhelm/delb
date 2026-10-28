import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:4317';
const targets = await (await fetch('http://127.0.0.1:9231/json/list')).json();
const ws = new WebSocket(
  targets.find((t) => t.type === 'page').webSocketDebuggerUrl,
);
await new Promise((resolve) =>
  ws.addEventListener('open', resolve, { once: true }),
);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const item = JSON.parse(event.data);
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
      if (pending.has(id)) {
        pending.delete(id);
        reject(Error(method + ' timeout'));
      }
    }, 20000).unref();
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
  for (let i = 0; i < 40; i++) {
    if (await evaluate(expression)) return;
    await sleep(250);
  }
  throw Error('Timed out: ' + expression);
}
async function navigate(path) {
  await Promise.race([
    call('Page.navigate', { url: base + path }),
    sleep(1000),
  ]);
  await sleep(1500);
}
async function key(key, code, modifiers = 0) {
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: key === 'Enter' ? '\r' : undefined,
    key,
    code,
    modifiers,
    windowsVirtualKeyCode:
      { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40 }[key] ??
      key.toUpperCase().charCodeAt(0),
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode:
      { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40 }[key] ??
      key.toUpperCase().charCodeAt(0),
  });
}
const records = [];
function pass(name, evidence) {
  records.push({ check: name, evidence });
  console.log('PASS', name, JSON.stringify(evidence));
}
await call('Page.enable');
await call('Page.bringToFront');
await navigate('/__review/reader.html');
await waitFor('typeof ePub === "function"');
const setup = await evaluate(
  `(async()=>{const registration=await fetch('/api/auth/sign-up/email',{method:'POST',signal:AbortSignal.timeout(10000),headers:{Origin:location.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'Browser Audit',email:'repair-browser-'+crypto.randomUUID()+'@example.invalid',password:crypto.randomUUID()})});if(!registration.ok)return {registration:registration.status};const form=new FormData();form.append('file',new Blob([await(await fetch('/__review/audit-script.epub')).arrayBuffer()],{type:'application/epub+zip'}),'audit-script.epub');form.append('allowDuplicate','true');const upload=await fetch('/api/books/upload',{method:'POST',body:form,signal:AbortSignal.timeout(10000)});const json=await upload.json();return {registration:registration.status,upload:upload.status,bookId:json.data?.results?.find(r=>r.success)?.book?.id,errors:json.data?.results?.filter(r=>!r.success)};})()`,
);
assert.equal(setup.registration, 200);
assert.equal(setup.upload, 200);
assert.ok(setup.bookId, JSON.stringify(setup));
pass('synthetic registration and EPUB upload', { status: setup.upload });
await navigate('/books/' + setup.bookId + '/read');
await waitFor(
  'document.querySelector("iframe")?.contentDocument?.body?.textContent.includes("Ordinary synthetic reading paragraph")',
);
function readerEvidence() {
  return evaluate(
    `({flow:document.querySelector('button[aria-label="Back to book"]')?.__vueParentComponent?.setupState?.renditionRef?.settings?.flow,sandbox:document.querySelector('iframe')?.getAttribute('sandbox'),parentMarker:window.__delbAuditParentAccess??null,bodyMarker:document.body.dataset.auditEpubScript??null,text:document.querySelector('iframe')?.contentDocument?.body?.textContent.includes('Ordinary synthetic reading paragraph')})`,
  );
}
let reader = await readerEvidence();
assert.ok(reader.text);
assert.ok(!reader.sandbox.includes('allow-scripts'));
assert.equal(reader.parentMarker, null);
assert.equal(reader.bodyMarker, null);
pass('authenticated reader blocks EPUB script parent access', reader);
await evaluate(
  `document.querySelector('button[aria-label="Reader settings"]').click();true`,
);
const controls = await evaluate(
  `({font:!!document.querySelector('input[type="range"][aria-label="Font size"]'),line:!!document.querySelector('input[type="range"][aria-label="Line height"]'),selects:[...document.querySelectorAll('select')].map(s=>({options:[...s.options].map(o=>o.value)}))})`,
);
assert.ok(controls.font && controls.line);
pass('reader controls have native labels', controls);
await evaluate(
  `document.querySelector('input[type="radio"][value="pages"]').click();true`,
);
await sleep(750);
reader = await readerEvidence();
assert.equal(reader.flow, 'paginated');
assert.ok(reader.text && !reader.sandbox.includes('allow-scripts'));
pass('pages reader remains script disabled', reader);
const changed = await evaluate(
  `(()=>{const radio=document.querySelector('input[type="radio"][value="scroll"]');if(!radio)return false;radio.click();return true;})()`,
);
assert.ok(changed);
await sleep(1000);
await waitFor(
  'document.querySelector("iframe")?.contentDocument?.body?.textContent.includes("Ordinary synthetic reading paragraph")',
);
reader = await readerEvidence();
assert.ok(reader.text && !reader.sandbox.includes('allow-scripts'));
assert.equal(reader.parentMarker, null);
assert.equal(reader.flow, 'scrolled');
pass('scroll reader remains script disabled', reader);
await evaluate(
  `document.querySelector('input[type="radio"][value="pages"]').click();document.querySelector('button[aria-label="Reader settings"]').click();document.querySelector('button[aria-label="Table of contents"]').focus();true`,
);
await key('Enter', 'Enter');
await waitFor(
  `!!document.querySelector('button[aria-label="Close table of contents"]')`,
);
pass('keyboard opens table of contents', { nativeButton: true });
await evaluate(
  `document.querySelector('button[aria-label="Close table of contents"]').click();true`,
);
const visibleLocation = await evaluate(
  `(async()=>{const button=document.querySelector('button[aria-label="Next page"]');const rendition=button.__vueParentComponent?.setupState?.renditionRef;if(!rendition)throw Error('Reader rendition unavailable');const relocated=new Promise(resolve=>rendition.once('relocated',location=>resolve(location.start.cfi)));button.click();const cfi=await relocated;document.querySelector('button[aria-label="Back to book"]').click();return cfi;})()`,
);
await waitFor(`!location.pathname.endsWith('/read')`);
const saved = await evaluate(
  `(async()=>{const r=await fetch('/api/books/${setup.bookId}/reading-position');const j=await r.json();return {status:r.status,hasLocation:!!j.data?.location,location:j.data?.location};})()`,
);
assert.equal(saved.status, 200);
assert.ok(saved.hasLocation);
assert.equal(saved.location, visibleLocation);
pass('rapid in-app exit persists location', saved);
const modifiers = await evaluate(
  '/Mac|iPod|iPhone|iPad/.test(navigator.platform)?4:2',
);
await key('k', 'KeyK', modifiers);
await waitFor('!!document.querySelector("[role=dialog] input[role=combobox]")');
await call('Input.insertText', { text: 'Synthetic Audit Origin' });
await sleep(800);
await key('ArrowDown', 'ArrowDown');
const search = await evaluate(
  `(()=>{const input=document.querySelector('[role=dialog] input[role=combobox]');const id=input?.getAttribute('aria-activedescendant');return {label:input?.getAttribute('aria-label'),list:!!document.getElementById(input?.getAttribute('aria-controls')),active:!!(id&&document.getElementById(id)),options:document.querySelectorAll('[role=option]').length};})()`,
);
assert.ok(search.label && search.list && search.active && search.options);
pass('global search exposes selected results', search);
await key('Escape', 'Escape');
await key('p', 'KeyP', modifiers | 8);
await waitFor(
  `!!document.querySelector('[role=dialog][aria-label="Command palette"] input')`,
);
await key('ArrowDown', 'ArrowDown');
const palette = await evaluate(
  `(()=>{const dialog=document.querySelector('[role=dialog][aria-label="Command palette"]');const input=dialog.querySelector('input');const id=input.getAttribute('aria-activedescendant');const controls=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex="0"]')];controls.at(-1)?.focus();return {list:!!document.getElementById(input.getAttribute('aria-controls')),active:!!document.getElementById(id),controls:controls.length};})()`,
);
assert.ok(palette.list && palette.active);
await key('Tab', 'Tab');
assert.ok(
  await evaluate(
    `document.querySelector('[role=dialog][aria-label="Command palette"]').contains(document.activeElement)`,
  ),
);
pass('command palette names results and contains keyboard focus', palette);
await key('Escape', 'Escape');
await writeFile(
  'review/audits/2026-10-27/browser-results.json',
  JSON.stringify(records, null, 2) + '\n',
);
ws.close();
