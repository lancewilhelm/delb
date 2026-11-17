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
  const collection = (
    await ok(
      await request(owner, '/api/collections', 'POST', { name: 'MCP library' }),
    )
  ).data.collection.id;
  await ok(
    await request(owner, `/api/collections/${collection}/members`, 'PUT', {
      email: reader.email,
      role: 'viewer',
    }),
  );
  const secondCollection = (
    await ok(
      await request(owner, '/api/collections', 'POST', {
        name: 'Another collection',
      }),
    )
  ).data.collection.id;
  await ok(
    await request(
      owner,
      `/api/collections/${secondCollection}/members`,
      'PUT',
      { email: reader.email, role: 'viewer' },
    ),
  );
  async function createBook(title, collectionId = collection) {
    return (
      await ok(
        await request(owner, '/api/books', 'POST', {
          title,
          authors: ['Author'],
          collectionIds: [collectionId],
        }),
      )
    ).data.book.id;
  }
  const first = await createBook('First TBR');
  const second = await createBook('Second TBR', secondCollection);
  const reading = await createBook('Reading book');
  const ownerToken = await ok(
    await request(owner, '/api/mcp-connections', 'POST', {
      name: 'Hermes',
      canWrite: true,
    }),
  );
  const readOnlyToken = await ok(
    await request(owner, '/api/mcp-connections', 'POST', {
      name: 'Read only',
      canWrite: false,
    }),
  );
  const readerToken = await ok(
    await request(reader, '/api/mcp-connections', 'POST', {
      name: 'Viewer',
      canWrite: true,
      canEditMetadata: true,
    }),
  );
  const writer = await connect(ownerToken.token);
  clients.push(writer);
  const readOnly = await connect(readOnlyToken.token);
  clients.push(readOnly);
  const viewer = await connect(readerToken.token);
  clients.push(viewer);
  const toolNames = (await writer.listTools()).tools.map((t) => t.name);
  for (const name of ['list_my_tbr', 'set_tbr_note', 'update_book_metadata'])
    assert.ok(toolNames.includes(name));

  assert.ok(
    (await call(writer, 'search_books', { statuses: ['none'] })).items.some(
      (book) => book.id === first,
    ),
  );
  await call(writer, 'set_reading_status', {
    bookId: first,
    status: 'to_be_read',
  });
  await call(writer, 'set_reading_status', {
    bookId: second,
    status: 'to_be_read',
  });
  await call(writer, 'set_reading_status', {
    bookId: reading,
    status: 'reading',
    startedAt: '2024-03-05',
  });
  await call(writer, 'set_tbr_note', {
    bookId: second,
    note: '  From a friend  ',
  });
  assert.equal(
    (await ok(await request(owner, `/api/books/${second}/rationale`))).data
      .rationale,
    'From a friend',
  );
  assert.equal((await call(viewer, 'get_book', { bookId: second })).note, null);
  await fails(readOnly, 'set_tbr_note', { bookId: second, note: 'No' });
  const list = await call(writer, 'list_my_tbr', { limit: 1 });
  assert.equal(list.items[0].id, first);
  assert.equal(
    (await call(writer, 'list_my_tbr', { after: list.nextCursor })).items[0]
      .note,
    'From a friend',
  );
  await call(writer, 'set_reading_status', { bookId: second, tbrRank: 1 });
  assert.deepEqual(
    (await call(writer, 'list_my_tbr')).items.map((b) => b.id),
    [second, first],
  );
  const readingBooks = await call(writer, 'search_books', {
    statuses: ['reading'],
  });
  assert.deepEqual(
    readingBooks.items.map((b) => b.id),
    [reading],
  );
  assert.equal(calendarDate(readingBooks.items[0].startedAt), '2024-03-05');
  assert.ok(
    (
      await call(writer, 'search_books', { statuses: ['to_be_read'] })
    ).items.some(
      (b) => b.id === second && b.note === 'From a friend' && b.tbrRank === 1,
    ),
  );
  const finished = await call(writer, 'set_reading_status', {
    bookId: reading,
    status: 'finished',
    finishedAt: '2024-03-20',
  });
  assert.equal(calendarDate(finished.startedAt), '2024-03-05');
  assert.equal(calendarDate(finished.finishedAt), '2024-03-20');
  await call(writer, 'set_reading_status', {
    bookId: reading,
    finishedAt: '2024-03-21',
  });
  assert.equal(
    calendarDate(
      (await call(writer, 'get_book', { bookId: reading })).finishedAt,
    ),
    '2024-03-21',
  );
  await fails(writer, 'set_reading_status', {
    bookId: reading,
    finishedAt: '2024-03-01',
  });
  await fails(writer, 'set_reading_status', {
    bookId: reading,
    startedAt: '2024-02-31',
  });
  await fails(writer, 'set_reading_status', { bookId: reading, tbrRank: 1 });
  const dnf = await call(writer, 'set_reading_status', {
    bookId: reading,
    status: 'dnf',
    dnfAt: '2024-04-01',
  });
  assert.equal(dnf.status, 'dnf');
  assert.equal(calendarDate(dnf.dnfAt), '2024-04-01');
  assert.equal(dnf.finishedAt, null);
  await call(writer, 'set_reading_status', {
    bookId: reading,
    dnfAt: '2024-04-02',
  });
  assert.equal(
    calendarDate((await call(writer, 'get_book', { bookId: reading })).dnfAt),
    '2024-04-02',
  );

  const before = await call(writer, 'get_book', { bookId: first });
  await fails(writer, 'update_book_metadata', {
    bookId: first,
    expectedVersion: before.metadataVersion,
    changes: { title: 'Denied' },
  });
  assert.equal(
    (
      await request(reader, '/api/mcp-connections', 'PATCH', {
        id: ownerToken.id,
        canEditMetadata: true,
      })
    ).status,
    404,
  );
  await ok(
    await request(owner, '/api/mcp-connections', 'PATCH', {
      id: ownerToken.id,
      canEditMetadata: true,
    }),
  );
  assert.equal(
    (await ok(await request(owner, '/api/mcp-connections'))).find(
      (c) => c.id === ownerToken.id,
    ).canEditMetadata,
    true,
  );
  await fails(viewer, 'update_book_metadata', {
    bookId: first,
    expectedVersion: before.metadataVersion,
    changes: { title: 'No editor rights' },
  });
  const updated = await call(writer, 'update_book_metadata', {
    bookId: first,
    expectedVersion: before.metadataVersion,
    changes: {
      title: 'Corrected title',
      authors: ['Correct Author'],
      published: '2005',
      tags: ['Fantasy'],
      identifiers: [{ type: 'isbn', value: '9781234567890' }],
    },
  });
  assert.equal(typeof updated.storageWarning, 'boolean');
  assert.equal(updated.book.title, 'Corrected title');
  assert.deepEqual(updated.book.authors, ['Correct Author']);
  assert.deepEqual(updated.book.tags, ['Fantasy']);
  assert.deepEqual(updated.book.identifiers, [
    { type: 'isbn', value: '9781234567890' },
  ]);
  assert.notEqual(updated.book.metadataVersion, before.metadataVersion);
  await fails(writer, 'update_book_metadata', {
    bookId: first,
    expectedVersion: before.metadataVersion,
    changes: { description: 'Stale edit' },
  });
  await ok(
    await request(owner, `/api/books/${first}`, 'PUT', {
      tags: ['Changed in Delb'],
    }),
  );
  await fails(writer, 'update_book_metadata', {
    bookId: first,
    expectedVersion: updated.book.metadataVersion,
    changes: { description: 'Stale tags' },
  });
  assert.deepEqual((await call(writer, 'get_book', { bookId: first })).tags, [
    'Changed in Delb',
  ]);
  await ok(
    await request(owner, '/api/mcp-connections', 'PATCH', {
      id: ownerToken.id,
      canEditMetadata: false,
    }),
  );
  const current = await call(writer, 'get_book', { bookId: first });
  await fails(writer, 'update_book_metadata', {
    bookId: first,
    expectedVersion: current.metadataVersion,
    changes: { title: 'Permission removed' },
  });
  const metadataOnlyToken = await ok(
    await request(owner, '/api/mcp-connections', 'POST', {
      name: 'Metadata only',
      canWrite: false,
      canEditMetadata: true,
    }),
  );
  const metadataOnly = await connect(metadataOnlyToken.token);
  clients.push(metadataOnly);
  const metadataOnlyBook = await call(metadataOnly, 'get_book', {
    bookId: first,
  });
  await fails(metadataOnly, 'set_reading_status', {
    bookId: first,
    status: 'reading',
  });
  const metadataOnlyUpdate = await call(metadataOnly, 'update_book_metadata', {
    bookId: first,
    expectedVersion: metadataOnlyBook.metadataVersion,
    changes: { description: 'Updated description' },
  });
  assert.equal(metadataOnlyUpdate.book.description, 'Updated description');
  await call(writer, 'set_reading_status', {
    bookId: second,
    status: 'reading',
  });
  assert.equal(
    (await call(writer, 'get_book', { bookId: second })).note,
    'From a friend',
  );
  await call(writer, 'set_reading_status', {
    bookId: second,
    status: 'to_be_read',
    tbrRank: 1,
  });
  await call(writer, 'set_tbr_note', { bookId: second, note: '' });
  assert.equal((await call(writer, 'list_my_tbr')).items[0].note, '');
  console.log(
    'PASS MCP status dates, TBR order and notes, and metadata permissions and conflicts',
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
}
