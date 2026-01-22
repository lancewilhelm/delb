import { and, eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionMembers, collections, users } from '~/utils/db/schema';
import { parseDropboxIngestSettings } from './config';
import { getGlobalSettingsRow } from './settings';

export type DropboxTarget = {
  collectionId: string;
  /**
   * For provenance. Nullable because dropbox ingestion is "server-side",
   * and we may not have a user context.
   */
  addedByUserId: string | null;
};

async function getPersonalCollectionIdForUser(userId: string): Promise<string> {
  const rows = await cloudDb
    .select({ id: collections.id })
    .from(collectionMembers)
    .innerJoin(collections, eq(collectionMembers.collectionId, collections.id))
    .where(
      and(eq(collectionMembers.userId, userId), eq(collections.isPersonal, true)),
    )
    .limit(1);

  const id = rows[0]?.id;
  if (!id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Personal collection not found for dropbox user',
    });
  }
  return id;
}

async function resolveUserIdFromSettings(): Promise<string | null> {
  const row = await getGlobalSettingsRow();
  const dropbox = parseDropboxIngestSettings(row?.settings);

  const byId = (dropbox.targetUserId ?? '').toString().trim();
  if (byId) return byId;

  const byEmail = (dropbox.targetUserEmail ?? '').toString().trim();
  if (byEmail) {
    const rows = await cloudDb
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, byEmail))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  // Default to "first user" for single-user setups.
  const first = await cloudDb.select({ id: users.id }).from(users).limit(1);
  return first[0]?.id ?? null;
}

/**
 * Resolve which collection new dropbox-ingested books should land in.
 *
 * Precedence:
 * - Global setting `dropbox.targetCollectionId`
 * - personal collection of `dropbox.targetUserId` / `dropbox.targetUserEmail`
 * - personal collection of the "first user" in the DB (single-user default)
 */
export async function resolveDropboxTarget(): Promise<DropboxTarget> {
  const row = await getGlobalSettingsRow();
  const dropbox = parseDropboxIngestSettings(row?.settings);

  const explicitCollectionId = (dropbox.targetCollectionId ?? '').toString().trim();

  if (explicitCollectionId) {
    const addedByUserId = (dropbox.targetUserId ?? '').toString().trim();
    return {
      collectionId: explicitCollectionId,
      addedByUserId: addedByUserId || null,
    };
  }

  const userId = await resolveUserIdFromSettings();
  if (!userId) {
    throw createError({
      statusCode: 400,
      statusMessage:
        'No users exist to receive dropbox books; create a user or set dropbox.targetCollectionId',
    });
  }

  return {
    collectionId: await getPersonalCollectionIdForUser(userId),
    addedByUserId: userId,
  };
}
