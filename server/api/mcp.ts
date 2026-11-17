import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { sendWebResponse } from 'h3';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';
import {
  authenticateConnection,
  type McpActor,
} from '~~/server/utils/mcp/connections';
import {
  editMetadata,
  getBook,
  listMyTbr,
  listCollections,
  myShelves,
  searchBooks,
  setShelf,
  setStatus,
  setTbrNote,
} from '~~/server/utils/mcp/library';

const id = z.string().min(1).max(128);
const status = z.enum(['to_be_read', 'reading', 'finished', 'dnf']);
const date = z.iso.date().nullable().optional();
const metadataChanges = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(12000).nullable().optional(),
    published: z.string().max(100).nullable().optional(),
    language: z.string().max(100).nullable().optional(),
    pages: z.number().int().min(0).max(1000000).nullable().optional(),
    publisherName: z.string().max(300).nullable().optional(),
    seriesName: z.string().max(300).nullable().optional(),
    seriesIndex: z.number().finite().nullable().optional(),
    authors: z
      .array(z.string().trim().min(1).max(300))
      .min(1)
      .max(100)
      .optional(),
    tags: z
      .array(z.string().trim().min(1).max(300))
      .max(100)
      .nullable()
      .optional(),
    identifiers: z
      .array(
        z.object({
          type: z
            .string()
            .regex(/^[A-Za-z0-9_]+$/)
            .max(50),
          value: z
            .string()
            .trim()
            .min(1)
            .max(300)
            .regex(/^[^\r\n]+$/),
        }),
      )
      .max(100)
      .nullable()
      .optional(),
  })
  .strict();
function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value == null) return value;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!);
}

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
                  : status === 409
                    ? 'Book metadata changed. Read the book again before updating it.'
                    : status === 400 && error instanceof Error
                      ? error.message
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
        statuses: z
          .array(z.union([status, z.literal('none')]))
          .min(1)
          .max(5)
          .optional()
          .describe(
            'Limit results to the chosen personal statuses; none means no status.',
          ),
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
      description:
        'Read book details, metadataVersion, your reading status and note. Truncated flags identify fields too large for safe replacement through MCP.',
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
    'list_my_tbr',
    {
      description:
        'List your To be read queue in its saved order, including each private note. Use nextCursor as after to continue.',
      inputSchema: z.object({
        after: id.optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: readOnly,
    },
    async ({ after, limit }) => result(() => listMyTbr(actor, after, limit)),
  );
  server.registerTool(
    'set_reading_status',
    {
      description:
        'Change your reading status, dates, or TBR rank. Dates are YYYY-MM-DD; null clears a date, subject to Delb status rules. A TBR rank moves the book to that 1-based position in your global queue. Include only fields you want to change. Marking a book finished may update reading progress.',
      inputSchema: z.object({
        bookId: id,
        status: status.nullable().optional(),
        startedAt: date,
        finishedAt: date,
        dnfAt: date,
        tbrRank: z.number().int().min(1).max(1000000).optional(),
      }),
      annotations: personalWrite,
    },
    async ({
      bookId,
      status: requestedStatus,
      startedAt,
      finishedAt,
      dnfAt,
      tbrRank,
    }) =>
      result(() => {
        if (
          requestedStatus === undefined &&
          startedAt === undefined &&
          finishedAt === undefined &&
          dnfAt === undefined &&
          tbrRank === undefined
        )
          throw createError({
            statusCode: 400,
            statusMessage: 'Choose a status, date, or TBR rank to change.',
          });
        return setStatus(actor, bookId, {
          status: requestedStatus,
          startedAt: parseDate(startedAt),
          finishedAt: parseDate(finishedAt),
          dnfAt: parseDate(dnfAt),
          tbrRank,
        });
      }),
  );
  server.registerTool(
    'set_tbr_note',
    {
      description:
        'Set or clear your private TBR note for an accessible book. An empty string clears it.',
      inputSchema: z.object({ bookId: id, note: z.string().max(10000) }),
      annotations: personalWrite,
    },
    async ({ bookId, note }) => result(() => setTbrNote(actor, bookId, note)),
  );
  server.registerTool(
    'update_book_metadata',
    {
      description:
        'Update only the supplied shared catalog fields. Read get_book first and provide its metadataVersion to prevent overwriting later changes. Authors, tags and identifiers replace their entire lists. Requires metadata permission and collection editor access. Changing title or authors may move managed storage; inspect storageWarning.',
      inputSchema: z.object({
        bookId: id,
        expectedVersion: z.string().regex(/^[0-9a-f]{64}$/),
        changes: metadataChanges,
      }),
      annotations: personalWrite,
    },
    async ({ bookId, expectedVersion, changes }) =>
      result(() => {
        if (!Object.keys(changes).length)
          throw createError({
            statusCode: 400,
            statusMessage: 'Choose metadata fields to change.',
          });
        const { identifiers, ...rest } = changes;
        return editMetadata(actor, bookId, expectedVersion, {
          ...rest,
          ...(identifiers === undefined
            ? {}
            : {
                identifiers:
                  identifiers === null
                    ? null
                    : identifiers
                        .map(({ type, value }) => `${type}:${value}`)
                        .join('\n'),
              }),
        });
      }),
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
