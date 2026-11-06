import path from 'node:path';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionActor } from '~~/server/utils/collections/http';
import {
  assertCollectionAdmin,
  CollectionError,
} from '~~/server/utils/collections/model';
import {
  applyCollectionMigration,
  type MigrationChoice,
} from '~~/server/utils/collections/migration';

export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  await assertCollectionAdmin(cloudDb, actor.id);
  const body = await readBody<unknown>(event);
  if (
    !body ||
    typeof body !== 'object' ||
    !('fingerprint' in body) ||
    typeof body.fingerprint !== 'string' ||
    !('choices' in body) ||
    !Array.isArray(body.choices) ||
    !('backupConfirmed' in body) ||
    body.backupConfirmed !== true
  )
    throw new CollectionError(
      400,
      'Preview the migration and confirm a database and library backup first',
    );
  const choices: MigrationChoice[] = body.choices.map((choice: unknown) => {
    if (
      !choice ||
      typeof choice !== 'object' ||
      !('bookId' in choice) ||
      typeof choice.bookId !== 'string' ||
      !('collectionId' in choice) ||
      typeof choice.collectionId !== 'string'
    )
      throw new CollectionError(400, 'Invalid migration choice');
    return { bookId: choice.bookId, collectionId: choice.collectionId };
  });
  const dropboxTargetId =
    'dropboxTargetId' in body ? body.dropboxTargetId : undefined;
  if (dropboxTargetId !== undefined && typeof dropboxTargetId !== 'string')
    throw new CollectionError(400, 'Invalid Dropbox destination');
  return {
    success: true,
    data: await applyCollectionMigration(
      cloudDb,
      path.resolve(process.cwd(), 'library'),
      {
        fingerprint: body.fingerprint,
        choices,
        backupConfirmed: true,
        dropboxTargetId,
      },
    ),
  };
});
