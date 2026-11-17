import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { fetchAuth } from './fetch-auth.mjs';

const base = 'http://127.0.0.1:4317';
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
  const client = new Client({ name: 'progress-test', version: '1.0' });
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
async function fails(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.content[0].text;
}
function calendarDate(input) {
  const date = new Date(input);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}
const clients = [];
try {
  const owner = await account('owner');
  const reader = await account('reader');
  const outsider = await account('outsider');
  const collection = (
    await ok(
      await request(owner, '/api/collections', 'POST', {
        name: 'Progress collection',
      }),
    )
  ).data.collection.id;
  await ok(
    await request(owner, `/api/collections/${collection}/members`, 'PUT', {
      email: reader.email,
      role: 'viewer',
    }),
  );
  async function createBook(title, pages) {
    return (
      await ok(
        await request(owner, '/api/books', 'POST', {
          title,
          authors: ['Test author'],
          pages,
          collectionIds: [collection],
        }),
      )
    ).data.book.id;
  }
  const book = await createBook('Progress book', 120);
  const noPages = await createBook('No page count', null);
  async function newToken(user, canWrite) {
    return ok(
      await request(user, '/api/mcp-connections', 'POST', {
        name: 'Progress',
        canWrite,
      }),
    );
  }
  const ownerToken = await newToken(owner, true);
  const readOnlyToken = await newToken(owner, false);
  const viewerToken = await newToken(reader, true);
  const outsiderToken = await newToken(outsider, true);
  const writer = await connect(ownerToken.token);
  clients.push(writer);
  const readOnly = await connect(readOnlyToken.token);
  clients.push(readOnly);
  const viewer = await connect(viewerToken.token);
  clients.push(viewer);
  const stranger = await connect(outsiderToken.token);
  clients.push(stranger);
  const tools = (await writer.listTools()).tools;
  assert.equal(
    tools.find((tool) => tool.name === 'log_reading_progress').annotations
      .idempotentHint,
    false,
  );
  assert.ok(tools.some((tool) => tool.name === 'get_reading_progress'));
  await ok(
    await request(owner, `/api/books/${book}/reading-position`, 'PUT', {
      location: 'epubcfi(/6/4)',
      progress: 11,
    }),
  );
  await call(writer, 'set_reading_status', {
    bookId: book,
    status: 'reading',
    startedAt: '2024-01-01',
  });
  let progress = await call(writer, 'get_reading_progress', { bookId: book });
  assert.equal(progress.pageCount, 120);
  assert.equal(progress.progressSyncEnabled, false);
  assert.equal(progress.readerPosition.progress, 11);
  assert.deepEqual(progress.history, []);
  const page = await call(writer, 'log_reading_progress', {
    bookId: book,
    pageNumber: 30,
    occurredAt: '2024-02-01',
  });
  assert.equal(page.progressPercent, 25);
  assert.equal(page.pageNumber, 30);
  assert.equal(page.source, 'manual');
  assert.equal(calendarDate(page.occurredAt), '2024-02-01');
  const percent = await call(writer, 'log_reading_progress', {
    bookId: book,
    progressPercent: 42.5,
    occurredAt: '2024-03-01',
  });
  assert.equal(percent.pageNumber, null);
  progress = await call(writer, 'get_reading_progress', {
    bookId: book,
    limit: 1,
  });
  assert.equal(progress.history.length, 1);
  assert.equal(progress.history[0].progressPercent, 42.5);
  assert.equal(progress.readerPosition.progress, 11);
  const position = (
    await ok(await request(owner, `/api/books/${book}/reading-position`))
  ).data;
  assert.deepEqual(position, { location: 'epubcfi(/6/4)', progress: 11 });
  const uiLogs = (
    await ok(await request(owner, `/api/books/${book}/progress-logs`))
  ).data.logs;
  assert.deepEqual(
    uiLogs.map((log) => log.progressPercent),
    [42.5, 25],
  );
  assert.equal(
    (await call(writer, 'get_book', { bookId: book })).status,
    'reading',
  );
  await fails(readOnly, 'log_reading_progress', {
    bookId: book,
    progressPercent: 20,
  });
  await fails(stranger, 'get_reading_progress', { bookId: book });
  await fails(stranger, 'log_reading_progress', {
    bookId: book,
    progressPercent: 20,
  });
  assert.deepEqual(
    (await call(viewer, 'get_reading_progress', { bookId: book })).history,
    [],
  );
  await call(viewer, 'log_reading_progress', {
    bookId: book,
    progressPercent: 70,
  });
  assert.equal(
    (await call(writer, 'get_reading_progress', { bookId: book })).history
      .length,
    2,
  );
  await fails(writer, 'log_reading_progress', { bookId: book });
  await fails(writer, 'log_reading_progress', {
    bookId: book,
    progressPercent: 20,
    pageNumber: 30,
  });
  await fails(writer, 'log_reading_progress', {
    bookId: book,
    pageNumber: 121,
  });
  await fails(writer, 'log_reading_progress', {
    bookId: noPages,
    pageNumber: 1,
  });
  await fails(writer, 'log_reading_progress', {
    bookId: book,
    progressPercent: 101,
  });
  await fails(writer, 'log_reading_progress', {
    bookId: book,
    progressPercent: 20,
    occurredAt: '2024-02-31',
  });
  await ok(
    await request(owner, `/api/books/${book}/progress-sync`, 'PUT', {
      enabled: true,
    }),
  );
  const completed = await call(writer, 'log_reading_progress', {
    bookId: book,
    progressPercent: 100,
  });
  assert.equal(completed.progressPercent, 100);
  progress = await call(writer, 'get_reading_progress', { bookId: book });
  assert.equal(progress.progressSyncEnabled, true);
  assert.equal(progress.history[0].progressPercent, 100);
  assert.deepEqual(
    (await ok(await request(owner, `/api/books/${book}/reading-position`)))
      .data,
    position,
  );
  assert.equal(
    (await call(writer, 'get_book', { bookId: book })).status,
    'reading',
  );
  const manual = (
    await ok(
      await request(owner, `/api/books/${book}/progress-logs`, 'POST', {
        pageNumber: 60,
        occurredAt: '2024-02-05',
      }),
    )
  ).data.log;
  assert.equal(manual.progressPercent, 50);
  assert.equal(
    (
      await request(owner, `/api/books/${book}/progress-logs`, 'POST', {
        pageNumber: 121,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(owner, `/api/books/${noPages}/progress-logs`, 'POST', {
        pageNumber: 1,
      })
    ).status,
    400,
  );
  await ok(
    await request(
      owner,
      `/api/collections/${collection}/members/${reader.id}`,
      'DELETE',
    ),
  );
  await fails(viewer, 'get_reading_progress', { bookId: book });
  await fails(viewer, 'log_reading_progress', {
    bookId: book,
    progressPercent: 80,
  });
  await ok(
    await request(owner, '/api/mcp-connections', 'DELETE', {
      id: ownerToken.id,
    }),
  );
  await assert.rejects(() =>
    writer.callTool({
      name: 'log_reading_progress',
      arguments: { bookId: book, progressPercent: 80 },
    }),
  );
  console.log(
    'PASS MCP progress history, page conversion, reader position, authorization and visibility',
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
}
