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
}
const out = [];
const add = (x) => {
  out.push(x);
  console.log(JSON.stringify(x));
};
await call('Page.enable');
await navigate('http://127.0.0.1:4317/__review/descriptions.html');
await sleep(1200);
add({
  check: 'native DOM description sanitizer',
  result: await evaluate('document.querySelector("#results")?.textContent'),
});
for (const mode of ['pages', 'scroll']) {
  await navigate('http://127.0.0.1:4317/__review/reader.html');
  await sleep(500);
  await evaluate(
    `document.querySelector('#mode').value=${JSON.stringify(mode)};document.querySelector('#scripts').checked=false;document.querySelector('#load').click();true`,
  );
  await sleep(1700);
  await evaluate(`document.querySelector('#next').click();true`);
  await sleep(300);
  await evaluate(
    `document.querySelector('#chapter').click();document.querySelector('#theme').click();true`,
  );
  await sleep(600);
  add({
    check: 'ordinary EPUB ' + mode + ' scripts disabled',
    result: await evaluate('document.querySelector("#results")?.textContent'),
  });
}
await navigate('http://127.0.0.1:4317/login');
await sleep(1000);
add({
  check: 'application login page',
  result: await evaluate(
    '({title:document.title,headings:[...document.querySelectorAll("h1,h2")].map(e=>e.textContent),inputs:document.querySelectorAll("input").length,body:document.body.innerText.slice(0,400)})',
  ),
});
console.log(JSON.stringify(out, null, 2));
await writeFile(
  'audit-browser-results.json',
  JSON.stringify(out, null, 2) + '\n',
);
ws.close();
