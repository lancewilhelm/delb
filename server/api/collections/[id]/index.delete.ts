import { and, eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { collectionMembers, collections } from '~/utils/db/schema';

/**
 * DELETE /api/collections/:id
 *
 * Minimal sharing/RBAC v1:
 * - roles: owner | editor | viewer
 * - only owners can delete a collection
 *
 * Guardrails:
 * - personal collections must not be deletable
 *
 * Behavior:
 * - Deleting the collection cascades any `collection_members` and `collection_books`
 *   rows due to FK constraints (onDelete: "cascade").
 */
export default defineEventHandler(async (event) => {
  const id =
    typeof event.context?.params?.id === 'string'
      ? event.context.params.id
      : '';
  logger.debug(`DELETE /api/collections/${id}`);

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

  const userId = session.user.id;

  // Load collection to:
  // - ensure it exists
  // - guard against deleting Personal collections
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
      statusMessage: 'Personal collections cannot be deleted',
    });
  }

  // Owner-only (minimal v1)
  const membership = await cloudDb
    .select({ role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.userId, userId),
      ),
    )
    .limit(1);

  const role = membership[0]?.role;
  if (role !== 'owner') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }

  // Delete collection row. Dependent rows should cascade via schema.
  await cloudDb.delete(collections).where(eq(collections.id, id));

  return {
    success: true,
    data: {
      deleted: true,
      id,
    },
  };
});
