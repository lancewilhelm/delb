import { and, eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { collectionMembers, collections, users } from '~/utils/db/schema';

/**
 * PUT /api/collections/:id/members
 *
 * Body:
 * - email: string (required)
 * - role: "owner" | "editor" | "viewer" (required)
 *
 * Permissions:
 * - must be a member with role: "owner" | "editor"
 *
 * Guardrails:
 * - personal collections are not shareable
 * - you cannot change your own role (owner/editor must transfer ownership via a dedicated flow later)
 *
 * Notes:
 * - If the member already exists, their role is updated.
 */
export default defineEventHandler(async (event) => {
  const id =
    typeof event.context?.params?.id === 'string'
      ? event.context.params.id
      : '';
  logger.debug(`PUT /api/collections/${id}/members`);

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  if (!id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Collection id is required',
    });
  }

  const body = (await readBody(event).catch(() => null)) as {
    email?: unknown;
    role?: unknown;
  } | null;

  const emailRaw = typeof body?.email === 'string' ? body.email : '';
  const email = emailRaw.trim().toLowerCase();

  const roleRaw = typeof body?.role === 'string' ? body.role : '';
  const role = roleRaw as 'owner' | 'editor' | 'viewer';

  if (!email) {
    throw createError({
      statusCode: 400,
      statusMessage: 'email is required',
    });
  }

  if (role !== 'owner' && role !== 'editor' && role !== 'viewer') {
    throw createError({
      statusCode: 400,
      statusMessage: 'role must be one of: owner, editor, viewer',
    });
  }

  // Resolve email -> userId
  const userRows = await cloudDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const targetUserId = userRows[0]?.id ?? '';
  if (!targetUserId) {
    throw createError({
      statusCode: 404,
      statusMessage: 'User not found',
    });
  }

  // Ensure collection exists and is not Personal (non-shareable)
  const c = await cloudDb
    .select({
      id: collections.id,
      isPersonal: collections.isPersonal,
    })
    .from(collections)
    .where(eq(collections.id, id))
    .limit(1);

  const collection = c[0];
  if (!collection?.id) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Collection not found',
    });
  }

  if (collection.isPersonal) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Personal collections are not shareable',
    });
  }

  const actingUserId = session.user.id;

  // Owner OR editor can manage members (minimal v1 per requirements)
  const actingMembership = await cloudDb
    .select({ role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.userId, actingUserId),
      ),
    )
    .limit(1);

  const actingRole = actingMembership[0]?.role;
  if (actingRole !== 'owner' && actingRole !== 'editor') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }

  // Guardrail: user cannot change their own role here.
  if (targetUserId === actingUserId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'You cannot change your own role',
    });
  }

  const now = new Date();

  // Upsert membership (manual upsert to stay compatible with SQLite/Drizzle setup)
  const existing = await cloudDb
    .select({ userId: collectionMembers.userId })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.userId, targetUserId),
      ),
    )
    .limit(1);

  if (existing[0]?.userId) {
    await cloudDb
      .update(collectionMembers)
      .set({ role })
      .where(
        and(
          eq(collectionMembers.collectionId, id),
          eq(collectionMembers.userId, targetUserId),
        ),
      );
  } else {
    await cloudDb.insert(collectionMembers).values({
      collectionId: id,
      userId: targetUserId,
      role,
      createdAt: now,
    });
  }

  return {
    success: true,
    data: {
      member: {
        userId: targetUserId,
        role,
      },
    },
  };
});
