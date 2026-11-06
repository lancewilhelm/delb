import { eq } from 'drizzle-orm';
import { systemState } from '../../../../app/utils/db/schema';
import type { CollectionConnection } from '../../collections/model';
import type { DropboxTarget } from './target';
import { unlink } from 'node:fs/promises';
import { sameFileContents } from '../storage/verified-copy';

export async function finishCommittedDropboxClaim(opts: {
  input: string;
  destination: string;
  removeDecision: () => Promise<void>;
}): Promise<void> {
  if (!(await sameFileContents(opts.input, opts.destination))) {
    throw new Error(`Dropbox committed copy cannot be verified: ${opts.input}`);
  }
  await unlink(opts.input);
  await opts.removeDecision();
}

// Claims keep their original destination across a restart or a default change.
// Store the plan before renaming the input; remove it only once the claim is gone.
export async function retainDropboxClaimTarget(
  db: CollectionConnection,
  operationId: string,
  target: DropboxTarget,
): Promise<DropboxTarget> {
  await db
    .insert(systemState)
    .values({
      key: `dropbox-claim:${operationId}`,
      value: JSON.stringify(target),
    })
    .onConflictDoNothing();
  return readDropboxClaimTarget(db, operationId);
}

export async function readDropboxClaimTarget(
  db: CollectionConnection,
  operationId: string,
): Promise<DropboxTarget> {
  const [row] = await db
    .select()
    .from(systemState)
    .where(eq(systemState.key, `dropbox-claim:${operationId}`));
  const value: unknown = row ? JSON.parse(row.value) : null;
  if (
    !value ||
    typeof value !== 'object' ||
    !('ownerUserId' in value) ||
    typeof value.ownerUserId !== 'string' ||
    !value.ownerUserId.trim() ||
    !('collectionIds' in value) ||
    !Array.isArray(value.collectionIds) ||
    value.collectionIds.length !== 1 ||
    typeof value.collectionIds[0] !== 'string' ||
    !value.collectionIds[0].trim()
  )
    throw new Error(
      'Dropbox claim has no valid retained destination. Review its original collection and retry the file explicitly.',
    );
  return {
    ownerUserId: value.ownerUserId,
    collectionIds: [value.collectionIds[0]],
  };
}

export async function removeDropboxClaimTarget(
  db: CollectionConnection,
  operationId: string,
) {
  await db
    .delete(systemState)
    .where(eq(systemState.key, `dropbox-claim:${operationId}`));
}
