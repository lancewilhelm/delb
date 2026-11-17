import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { sendWebResponse } from 'h3';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';
import {
  authenticateConnection,
  type McpActor,
} from '~~/server/utils/mcp/connections';
import {
  getBook,
  listCollections,
  myShelves,
  searchBooks,
  setShelf,
  setStatus,
} from '~~/server/utils/mcp/library';

const id = z.string().min(1).max(128);
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const personalWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

function buildServer(actor: McpActor) {
  const server = new McpServer({ name: 'delb', version: '1.0.0' });
  const result = async (operation: () => Promise<unknown>) => {
    try {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(await operation()) },
        ],
      };
    } catch (error: unknown) {
      const status =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? error.statusCode
          : undefined;
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text:
              status === 404
                ? 'Book or shelf not found.'
                : status === 403
                  ? 'Connection does not permit this change.'
                  : 'Delb could not complete the request.',
          },
        ],
      };
    }
  };
  server.registerTool(
    'list_collections',
    {
      description: 'List your accessible collections.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => result(() => listCollections(actor)),
  );
  server.registerTool(
    'search_books',
    {
      description:
        'Search or browse visible books by title, author, or identifier. Use nextCursor as after for the next page, keeping the same filters.',
      inputSchema: z.object({
        query: z.string().max(200).default(''),
        collectionId: id.optional(),
        shelfId: id.optional(),
        after: id.optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: readOnly,
    },
    async (input) => result(() => searchBooks(actor, input)),
  );
  server.registerTool(
    'get_book',
    {
      description: 'Read book details and your reading status.',
      inputSchema: z.object({ bookId: id }),
      annotations: readOnly,
    },
    async ({ bookId }) => result(() => getBook(actor, bookId)),
  );
  server.registerTool(
    'list_my_shelves',
    {
      description: 'List your personal shelves.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => result(() => myShelves(actor)),
  );
  server.registerTool(
    'set_reading_status',
    {
      description:
        'Set your reading status for a book. Use null to clear it. Marking a book finished can also update your reading progress.',
      inputSchema: z.object({
        bookId: id,
        status: z.enum(['to_be_read', 'reading', 'finished', 'dnf']).nullable(),
      }),
      annotations: personalWrite,
    },
    async ({ bookId, status }) =>
      result(() => setStatus(actor, bookId, status)),
  );
  server.registerTool(
    'set_shelf_membership',
    {
      description:
        'Add or remove a visible book from one of your personal shelves.',
      inputSchema: z.object({ shelfId: id, bookId: id, present: z.boolean() }),
      annotations: personalWrite,
    },
    async ({ shelfId, bookId, present }) =>
      result(() => setShelf(actor, shelfId, bookId, present)),
  );
  return server;
}

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  // This endpoint is for MCP clients, not browser JavaScript.
  if (getHeader(event, 'origin'))
    throw createError({
      statusCode: 403,
      statusMessage: 'Browser origins are not allowed.',
    });
  const actor = await authenticateConnection(getHeader(event, 'authorization'));
  if (!actor) {
    setHeader(event, 'WWW-Authenticate', 'Bearer');
    throw createError({
      statusCode: 401,
      statusMessage: 'Invalid or expired connection.',
    });
  }
  if (
    event.method !== 'POST' &&
    event.method !== 'GET' &&
    event.method !== 'DELETE'
  )
    throw createError({
      statusCode: 405,
      statusMessage: 'Method not allowed.',
    });
  let body: string | undefined;
  if (event.method === 'POST') {
    await cacheBoundedRequestBody(event.node.req, event.node.res, 64 * 1024);
    body = (await readRawBody(event)) ?? '';
  }
  const request = new Request(getRequestURL(event), {
    method: event.method,
    headers: event.headers,
    body,
  });
  const handler = createMcpHandler(() => buildServer(actor));
  return sendWebResponse(event, await handler.fetch(request));
});
