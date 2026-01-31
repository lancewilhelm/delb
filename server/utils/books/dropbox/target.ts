import { and, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionMembers, collections, users } from '~/utils/db/schema';
import { parseDropboxIngestSettings } from './config';
import { getGlobalSettingsRow } from './settings';

export type DropboxTarget = {
  /**
   * Owning user for the imported book.
   */
  ownerUserId: string;

  /**
   * Collections the book will be added to.
   * Must always include the owner's Personal collection (enforced here).
   */
  collectionIds: string[];
};

async function getPersonalCollectionIdForUser(userId: string): Promise<string> {
  const rows = await cloudDb
    .select({ id: collections.id })
    .from(collectionMembers)
    .innerJoin(collections, eq(collectionMembers.collectionId, collections.id))
    .where(
      and(
        eq(collectionMembers.userId, userId),
        eq(collections.isPersonal, true),
      ),
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

function uniqStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = (v ?? '').toString().trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Resolve which collection new dropbox-ingested books should land in.
 *
 * Precedence:
 * - Owner user from settings (or system owner fallback)
 * - Always add to owner's Personal collection
 * - Optionally also add to `dropbox.additionalCollectionIds` (and legacy `dropbox.targetCollectionId`)
 */
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

  const personalCollectionId =
    await getPersonalCollectionIdForUser(ownerUserId);

  // Additional collections (admin-configured). We intentionally exclude Personal;
  // Personal is always included via `personalCollectionId`.
  const legacySingle = (dropbox.targetCollectionId ?? '').toString().trim();
  const additional = uniqStrings(dropbox.additionalCollectionIds);
  const requested = Array.from(
    new Set([legacySingle, ...additional].filter(Boolean)),
  ).filter((id) => id !== personalCollectionId);

  // Validate existence so a stale setting doesn't break ingestion.
  const validAdditional = requested.length
    ? await cloudDb
        .select({ id: collections.id })
        .from(collections)
        .where(inArray(collections.id, requested))
    : [];

  const validAdditionalIds = validAdditional.map((r) => r.id).filter(Boolean);

  return {
    ownerUserId,
    collectionIds: [personalCollectionId, ...validAdditionalIds],
  };
}
