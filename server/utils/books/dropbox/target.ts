import { resolveBookTarget } from '~~/server/utils/collections/model';
import { eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { users } from '~/utils/db/schema';
import { parseDropboxIngestSettings } from './config';
import { getGlobalSettingsRow } from './settings';

export type DropboxTarget = { ownerUserId: string; collectionIds: string[] };

async function resolveOwnerUserIdFromSettings(): Promise<string | null> {
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

  // Default to system owner (role = "owner") when not explicitly configured.
  // If no owner exists (misconfigured DB), fall back to "first user".
  const ownerRows = await cloudDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'owner'))
    .limit(1);
  if (ownerRows[0]?.id) return ownerRows[0].id;

  const first = await cloudDb.select({ id: users.id }).from(users).limit(1);
  return first[0]?.id ?? null;
}

export async function resolveDropboxTarget(): Promise<DropboxTarget> {
  const row = await getGlobalSettingsRow();
  const dropbox = parseDropboxIngestSettings(row?.settings);

  const ownerUserId = await resolveOwnerUserIdFromSettings();
  if (!ownerUserId) {
    throw createError({
      statusCode: 400,
      statusMessage:
        'No users exist to receive dropbox books; create a user or set dropbox.targetUserId',
    });
  }

  const requested = Array.from(
    new Set(
      [
        dropbox.targetCollectionId,
        ...(dropbox.additionalCollectionIds ?? []),
      ].filter(
        (id): id is string => typeof id === 'string' && Boolean(id.trim()),
      ),
    ),
  );
  const collectionId = await resolveBookTarget(cloudDb, ownerUserId, requested);
  return { ownerUserId, collectionIds: [collectionId] };
}
