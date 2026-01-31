import { and, eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { collectionMembers, collections, users } from '~/utils/db/schema';

/**
 * POST /api/collections/:id/transfer-ownership
 *
 * Body:
 * - email: string (required)  // target user's email
 *
 * Behavior:
 * - Collections may have exactly one owner.
 * - Transfers ownership to the target user, making them the *sole* owner.
 * - Demotes the previous owner to "editor".
 * - Requires the acting user to be the current owner.
 *
 * Guardrails:
 * - Personal collections are not shareable and cannot transfer ownership.
 * - Target user must exist.
 * - Target user must already be a member of the collection OR will be added.
 * - You cannot transfer ownership to yourself.
 *
 * Response:
 * - { success: true, data: { ownerUserId: <newOwnerUserId> } }
 */
export default defineEventHandler(async (event) => {
  const id =
    typeof event.context?.params?.id === 'string'
      ? event.context.params.id
      : '';
  logger.debug(`POST /api/collections/${id}/transfer-ownership`);

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
  } | null;

  const emailRaw = typeof body?.email === 'string' ? body.email : '';
  const email = emailRaw.trim().toLowerCase();

  if (!email) {
    throw createError({
      statusCode: 400,
      statusMessage: 'email is required',
    });
  }

  // Ensure collection exists and is not Personal (non-shareable)
  const cRows = await cloudDb
    .select({
      id: collections.id,
      isPersonal: collections.isPersonal,
    })
    .from(collections)
    .where(eq(collections.id, id))
    .limit(1);

  const c = cRows[0];
  if (!c?.id) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Collection not found',
    });
  }

  if (c.isPersonal) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Personal collections cannot transfer ownership',
    });
  }

  const actingUserId = session.user.id;

  // Must be current owner
  const actingMembershipRows = await cloudDb
    .select({ role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.userId, actingUserId),
      ),
    )
    .limit(1);

  const actingRole = actingMembershipRows[0]?.role;
  if (actingRole !== 'owner') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }

  // Resolve email -> userId
  const userRows = await cloudDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const targetUserId = userRows[0]?.id ?? '';
  if (!targetUserId) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' });
  }

  if (targetUserId === actingUserId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'You cannot transfer ownership to yourself',
    });
  }

  // Ensure target is a member (insert if missing)
  const existingTargetRows = await cloudDb
    .select({ userId: collectionMembers.userId, role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.userId, targetUserId),
      ),
    )
    .limit(1);

  const now = new Date();

  if (!existingTargetRows[0]?.userId) {
    await cloudDb.insert(collectionMembers).values({
      collectionId: id,
      userId: targetUserId,
      role: 'viewer', // temporary until we promote to owner below
      createdAt: now,
    });
  }

  // Enforce single-owner invariant:
  // 1) demote *any* current owners to editor
  // 2) promote the target to owner
  //
  // This keeps the result deterministic even if legacy data somehow has >1 owner.
  await cloudDb
    .update(collectionMembers)
    .set({ role: 'editor' })
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.role, 'owner'),
      ),
    );

  await cloudDb
    .update(collectionMembers)
    .set({ role: 'owner' })
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.userId, targetUserId),
      ),
    );

  return {
    success: true,
    data: {
      ownerUserId: targetUserId,
    },
  };
});
