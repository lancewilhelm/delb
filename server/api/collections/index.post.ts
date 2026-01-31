import { and, eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { collectionMembers, collections } from '~/utils/db/schema';

/**
 * POST /api/collections
 *
 * Creates a new collection owned by the current user and adds them as an owner member.
 *
 * v1 Scope:
 * - name only
 * - no editing/deleting here yet
 * - no additional members here yet
 */
export default defineEventHandler(async (event) => {
  logger.debug('POST /api/collections');

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const body = (await readBody(event).catch(() => null)) as {
    name?: unknown;
  } | null;

  const rawName = typeof body?.name === 'string' ? body?.name : '';
  const name = rawName.trim();

  if (!name) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Collection name is required',
    });
  }

  // Keep this lean; you can tune limits later.
  if (name.length > 120) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Collection name is too long',
    });
  }

  const now = new Date();
  const collectionId = crypto.randomUUID();
  const userId = session.user.id;

  // Best-effort protection against accidental duplicates for a given owner.
  // (We can't enforce this at the DB level yet without adding a unique index.)
  // If you want duplicates, you can remove this later; for now it's a nicer UX.
  const existing = await cloudDb
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.ownerUserId, userId), eq(collections.name, name)))
    .limit(1);

  if (existing[0]?.id) {
    return {
      success: true,
      data: {
        collection: { id: existing[0].id, name },
        created: false,
      },
    };
  }

  await cloudDb.insert(collections).values({
    id: collectionId,
    name,
    ownerUserId: userId,
    isPersonal: false,
    createdAt: now,
    updatedAt: now,
  });

  await cloudDb.insert(collectionMembers).values({
    collectionId,
    userId,
    role: 'owner',
    createdAt: now,
  });

  return {
    success: true,
    data: {
      collection: { id: collectionId, name },
      created: true,
    },
  };
});
