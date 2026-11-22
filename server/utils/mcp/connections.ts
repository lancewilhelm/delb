import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { mcpConnections, users } from '~~/server/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';

export type McpActor = {
  userId: string;
  connectionId: string;
  canWrite: boolean;
  canEditMetadata: boolean;
};

export async function createConnection(
  userId: string,
  name: string,
  canWrite: boolean,
  canEditMetadata = false,
) {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const token = `delb_mcp_${id}.${secret}`;
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 365 * 24 * 60 * 60 * 1000);
  await cloudDb.insert(mcpConnections).values({
    id,
    userId,
    name,
    canWrite,
    canEditMetadata,
    createdAt,
    expiresAt,
    digest: createHash('sha256').update(secret).digest('hex'),
  });
  return { id, name, canWrite, canEditMetadata, createdAt, expiresAt, token };
}

export async function authenticateConnection(
  header: string | undefined,
): Promise<McpActor | null> {
  const match = /^Bearer delb_mcp_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
    header ?? '',
  );
  if (!match) return null;
  const [row] = await cloudDb
    .select({ connection: mcpConnections, user: users })
    .from(mcpConnections)
    .innerJoin(users, eq(users.id, mcpConnections.userId))
    .where(eq(mcpConnections.id, match[1]!))
    .limit(1);
  if (!row || row.connection.expiresAt.getTime() <= Date.now()) return null;
  if (
    row.user.banned &&
    (!row.user.banExpires || row.user.banExpires.getTime() > Date.now())
  )
    return null;
  const expected = Buffer.from(row.connection.digest, 'hex');
  const actual = createHash('sha256').update(match[2]!).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  return {
    userId: row.user.id,
    connectionId: row.connection.id,
    canWrite: row.connection.canWrite,
    canEditMetadata: row.connection.canEditMetadata,
  };
}

export async function listConnections(userId: string) {
  return cloudDb
    .select({
      id: mcpConnections.id,
      name: mcpConnections.name,
      canWrite: mcpConnections.canWrite,
      canEditMetadata: mcpConnections.canEditMetadata,
      createdAt: mcpConnections.createdAt,
      expiresAt: mcpConnections.expiresAt,
    })
    .from(mcpConnections)
    .where(eq(mcpConnections.userId, userId));
}

export async function revokeConnection(userId: string, id: string) {
  await cloudDb
    .delete(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.userId, userId)));
}

export async function authorizeWrite(
  tx: Parameters<Parameters<typeof cloudDb.transaction>[0]>[0],
  actor: McpActor,
  scope: 'personal' | 'metadata' = 'personal',
) {
  const [row] = await tx
    .select({ connection: mcpConnections, user: users })
    .from(mcpConnections)
    .innerJoin(users, eq(users.id, mcpConnections.userId))
    .where(
      and(
        eq(mcpConnections.id, actor.connectionId),
        eq(mcpConnections.userId, actor.userId),
      ),
    )
    .limit(1);
  if (
    !row ||
    !(scope === 'personal'
      ? row.connection.canWrite
      : row.connection.canEditMetadata) ||
    row.connection.expiresAt.getTime() <= Date.now() ||
    (row.user.banned &&
      (!row.user.banExpires || row.user.banExpires.getTime() > Date.now()))
  )
    throw createError({
      statusCode: 403,
      statusMessage: 'Connection no longer permits changes.',
    });
}

export async function setMetadataPermission(
  userId: string,
  id: string,
  canEditMetadata: boolean,
) {
  const updated = await cloudDb
    .update(mcpConnections)
    .set({ canEditMetadata })
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.userId, userId)))
    .returning({ id: mcpConnections.id });
  if (!updated.length)
    throw createError({
      statusCode: 404,
      statusMessage: 'Connection not found.',
    });
}
