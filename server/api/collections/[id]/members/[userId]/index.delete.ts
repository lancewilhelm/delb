import { and, eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { collectionMembers, collections } from '~/utils/db/schema';

/**
 * DELETE /api/collections/:id/members/:userId
 *
 * Minimal sharing/RBAC v1:
 * - roles: owner | editor | viewer
 * - owner OR editor can remove members
 *
 * Guardrails:
 * - personal collections are not shareable (enforced here)
 * - owner cannot remove themselves (keeps invariants simple)
 *
 * Response:
 * - { success: true, data: { removed: boolean } }
 */
export default defineEventHandler(async (event) => {
  const id =
    typeof event.context?.params?.id === 'string'
      ? event.context.params.id
      : '';
  const targetUserId =
    typeof event.context?.params?.userId === 'string'
      ? event.context.params.userId
      : '';

  logger.debug(`DELETE /api/collections/${id}/members/${targetUserId}`);

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

  if (!targetUserId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Member user id is required',
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

  // Owner/editor (minimal v1)
  const actingUserId = session.user.id;

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

  // v1 guard: you cannot remove yourself (owner must delete or transfer ownership)
  if (targetUserId === actingUserId) {
    throw createError({
      statusCode: 400,
      statusMessage:
        'You cannot remove yourself from a collection. Delete the collection or transfer ownership instead.',
    });
  }

  // Check whether the member exists first (so we can respond deterministically)
  const existing = await cloudDb
    .select({ userId: collectionMembers.userId, role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.userId, targetUserId),
      ),
    )
    .limit(1);

  if (!existing[0]?.userId) {
    return {
      success: true,
      data: {
        removed: false,
      },
    };
  }

  if (existing[0].role === 'owner') {
    throw createError({
      statusCode: 400,
      statusMessage:
        'You cannot remove the owner. Transfer ownership or delete the collection instead.',
    });
  }

  await cloudDb
    .delete(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.userId, targetUserId),
      ),
    );

  return {
    success: true,
    data: {
      removed: true,
    },
  };
});
