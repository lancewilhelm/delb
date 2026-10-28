import { writeFile } from 'node:fs/promises';
const targets = await (await fetch('http://127.0.0.1:9231/json/list')).json();
const ws = new WebSocket(
  targets.find((t) => t.type === 'page').webSocketDebuggerUrl,
);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const j = JSON.parse(e.data);
  if (j.id) {
    const p = pending.get(j.id);
    pending.delete(j.id);
    j.error ? p.reject(j.error) : p.resolve(j.result);
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
  const r = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function navigate(url) {
  await Promise.race([call('Page.navigate', { url }), sleep(1500)]);
  await sleep(700);
}
const records = [];
await call('Page.enable');
await navigate('http://127.0.0.1:4317/__review/reader.html');
for (const allow of [false, true]) {
  const result = await evaluate(
    `(async()=>{delete window.__delbAuditParentAccess;const b=ePub(await(await fetch('audit-script.epub')).arrayBuffer());await b.ready;const r=b.renderTo('reader',{manager:'continuous',flow:'paginated',width:'100%',height:'100%',allowScriptedContent:${allow}});await r.display();await new Promise(resolve=>setTimeout(resolve,400));const result={allowScriptedContent:${allow},parentMarker:window.__delbAuditParentAccess??null,frameSandbox:document.querySelector('#reader iframe')?.getAttribute('sandbox')};r.destroy();b.destroy();return result;})()`,
  );
  records.push({ check: 'EPUB parent-origin access', ...result });
  console.log(JSON.stringify(records.at(-1)));
}
await navigate('http://127.0.0.1:4317/login');
const setup = await evaluate(
  `(async()=>{const registration=await fetch('/api/auth/sign-up/email',{method:'POST',headers:{Origin:location.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'Browser Audit',email:'audit-browser-'+crypto.randomUUID()+'@example.invalid',password:crypto.randomUUID()})});if(!registration.ok)return {registration:registration.status};const form=new FormData();form.append('file',new Blob([await(await fetch('/__review/audit-script.epub')).arrayBuffer()],{type:'application/epub+zip'}),'audit-script.epub');form.append('allowDuplicate','true');const response=await fetch('/api/books/upload',{method:'POST',body:form});const json=await response.json();return {registration:registration.status,upload:response.status,bookId:json.data?.results?.find(r=>r.success)?.book?.id};})()`,
);
console.log(
  JSON.stringify({ check: 'synthetic authenticated reader setup', ...setup }),
);
if (setup.bookId) {
  await navigate('http://127.0.0.1:4317/books/' + setup.bookId + '/read');
  await sleep(2200);
  const result = await evaluate(
    `({url:location.pathname,title:document.title,parentMarker:window.__delbAuditParentAccess??null,bodyMarker:document.body.dataset.auditEpubScript??null,iframes:[...document.querySelectorAll('iframe')].map(e=>({sandbox:e.getAttribute('sandbox')}))})`,
  );
  records.push({ check: 'actual authenticated app reader', ...result });
  console.log(JSON.stringify(records.at(-1)));
}
await writeFile(
  'audit-origin-browser-results.json',
  JSON.stringify(records, null, 2) + '\n',
);
ws.close();
