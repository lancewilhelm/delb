import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createClient } from './sqlite-client.mjs';
import { spawnSync } from 'node:child_process';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { fetchAuth } from './fetch-auth.mjs';

const base = (
  process.env.DELB_REVIEW_URL ||
  process.env.BASE_URL ||
  'http://127.0.0.1:4317'
).replace(/\/$/, '');
const suffix = randomBytes(5).toString('hex');
async function account(name) {
  const response = await fetchAuth(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      email: `${name}-${suffix}@example.invalid`,
      password: randomBytes(20).toString('hex'),
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return {
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
    ...(await response.json()).user,
  };
}
async function request(actor, path, method = 'GET', body) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(actor ? { Cookie: actor.cookie } : {}),
      Origin: base,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function connect(token) {
  const client = new Client({ name: 'delb-test', version: '1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
const clients = [];
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
try {
  const owner = await account('owner');
  const outsider = await account('outsider');
  const collection = (
    await ok(
      await request(owner, '/api/collections', 'POST', { name: 'MCP tests' }),
    )
  ).data.collection.id;
  const book = (
    await ok(
      await request(owner, '/api/books', 'POST', {
        title: 'MCP Earthsea',
        authors: ['Ursula Le Guin'],
        collectionIds: [collection],
      }),
    )
  ).data.book.id;
  const shelf = (
    await ok(
      await request(owner, '/api/shelves', 'POST', { name: 'Favorites' }),
    )
  ).data.id;
  const ro = await ok(
    await request(owner, '/api/mcp-connections', 'POST', {
      name: 'Reader',
      canWrite: false,
    }),
  );
  const rw = await ok(
    await request(owner, '/api/mcp-connections', 'POST', {
      name: 'Hermes',
      canWrite: true,
    }),
  );
  const other = await ok(
    await request(outsider, '/api/mcp-connections', 'POST', {
      name: 'Other',
      canWrite: true,
    }),
  );
  assert.equal(
    (await fetch(`${base}/api/mcp`, { method: 'POST' })).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${rw.token}`, Origin: base },
      })
    ).status,
    403,
  );
  const listing = await ok(await request(owner, '/api/mcp-connections'));
  assert.equal(listing.length, 2);
  assert.ok(!JSON.stringify(listing).includes(ro.token));
  const legacyHeaders = {
    Authorization: `Bearer ${ro.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const legacyInit = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: legacyHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'legacy-test', version: '1' },
      },
    }),
  });
  assert.equal(legacyInit.status, 200, await legacyInit.clone().text());
  const legacyBody = await legacyInit.text();
  assert.match(legacyBody, /2025-03-26/);
  const legacyTools = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { ...legacyHeaders, 'MCP-Protocol-Version': '2025-03-26' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  });
  assert.equal(legacyTools.status, 200, await legacyTools.clone().text());
  assert.match(await legacyTools.text(), /search_books/);
  if (process.env.DELB_MCP_TEST_PYTHON) {
    const python = spawnSync(
      process.env.DELB_MCP_TEST_PYTHON,
      ['review/mcp-python-client.py'],
      { input: `${ro.token}\n`, encoding: 'utf8' },
    );
    assert.equal(python.status, 0, python.stderr);
    assert.match(python.stdout, /PASS Python MCP transport/);
  }
  const reader = await connect(ro.token);
  clients.push(reader);
  const writer = await connect(rw.token);
  clients.push(writer);
  const stranger = await connect(other.token);
  clients.push(stranger);
  const names = (await reader.listTools()).tools.map((t) => t.name);
  assert.ok(
    names.includes('search_books') && names.includes('set_reading_status'),
  );
  const search = await call(reader, 'search_books', {
    query: 'Ursula Le Guin',
  });
  assert.ok(search.items.some((b) => b.id === book));
  const detail = await call(reader, 'get_book', { bookId: book });
  assert.equal(detail.title, 'MCP Earthsea');
  assert.ok(!JSON.stringify(detail).includes('coverImagePath'));
  assert.equal(
    (await call(reader, 'list_my_shelves')).some((s) => s.id === shelf),
    true,
  );
  assert.equal(
    (
      await reader.callTool({
        name: 'set_reading_status',
        arguments: { bookId: book, status: 'reading' },
      })
    ).isError,
    true,
  );
  assert.equal(
    (await stranger.callTool({ name: 'get_book', arguments: { bookId: book } }))
      .isError,
    true,
  );
  assert.equal(
    (
      await stranger.callTool({
        name: 'set_shelf_membership',
        arguments: { shelfId: shelf, bookId: book, present: true },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await call(writer, 'set_reading_status', {
        bookId: book,
        status: 'reading',
      })
    ).status,
    'reading',
  );
  await ok(
    await request(owner, `/api/collections/${collection}/members`, 'PUT', {
      email: outsider.email,
      role: 'viewer',
    }),
  );
  assert.equal((await call(stranger, 'get_book', { bookId: book })).id, book);
  assert.equal(
    (
      await call(stranger, 'set_reading_status', {
        bookId: book,
        status: 'to_be_read',
      })
    ).status,
    'to_be_read',
  );
  await ok(
    await request(
      owner,
      `/api/collections/${collection}/members/${outsider.id}`,
      'DELETE',
    ),
  );
  assert.equal(
    (await stranger.callTool({ name: 'get_book', arguments: { bookId: book } }))
      .isError,
    true,
  );
  assert.equal(
    (
      await stranger.callTool({
        name: 'set_reading_status',
        arguments: { bookId: book, status: 'reading' },
      })
    ).isError,
    true,
  );
  await call(writer, 'set_shelf_membership', {
    shelfId: shelf,
    bookId: book,
    present: true,
  });
  assert.ok(
    (await call(writer, 'search_books', { shelfId: shelf })).items.some(
      (b) => b.id === book,
    ),
  );
  await call(writer, 'set_shelf_membership', {
    shelfId: shelf,
    bookId: book,
    present: false,
  });
  assert.equal(
    (await call(writer, 'search_books', { shelfId: shelf })).items.length,
    0,
  );
  await ok(
    await request(outsider, '/api/mcp-connections', 'DELETE', { id: rw.id }),
  );
  assert.equal((await call(writer, 'get_book', { bookId: book })).id, book);
  await db.execute({
    sql: 'UPDATE users SET banned = 1, ban_expires = NULL WHERE id = ?',
    args: [outsider.id],
  });
  await assert.rejects(() =>
    stranger.callTool({ name: 'list_my_shelves', arguments: {} }),
  );
  await db.execute({
    sql: 'UPDATE users SET banned = 0 WHERE id = ?',
    args: [outsider.id],
  });
  await call(stranger, 'list_my_shelves');
  await db.execute({
    sql: 'UPDATE mcp_connections SET expires_at = ? WHERE id = ?',
    args: [Date.now() - 1000, ro.id],
  });
  await assert.rejects(() =>
    reader.callTool({ name: 'list_my_shelves', arguments: {} }),
  );
  await ok(
    await request(owner, '/api/mcp-connections', 'DELETE', { id: rw.id }),
  );
  await assert.rejects(() =>
    writer.callTool({ name: 'get_book', arguments: { bookId: book } }),
  );
  console.log(
    'PASS MCP token lifecycle, transport, permissions and personal changes',
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  db.close();
}
