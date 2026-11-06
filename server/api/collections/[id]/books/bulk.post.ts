import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { books } from '~/utils/db/schema';
import {
  collectionActor,
  requiredCollectionId,
} from '~~/server/utils/collections/http';
import {
  assertCollectionEditor,
  moveCollectionBooks,
  CollectionError,
} from '~~/server/utils/collections/model';

function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((id: unknown) => typeof id !== 'string' || !id.trim()) ||
    value.length > 10000
  )
    throw new CollectionError(400, 'Invalid book selection');
  return [...new Set(value.map((id: string) => id.trim()))];
}
export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  const sourceId = requiredCollectionId(event);
  const body = await readBody<{
    bookIds?: unknown;
    allInCollection?: unknown;
    excludedBookIds?: unknown;
    targetCollectionId?: unknown;
    confirmed?: unknown;
  }>(event);
  if (typeof body?.targetCollectionId !== 'string' || body.confirmed !== true)
    throw new CollectionError(
      400,
      'Choose one destination and confirm the source collection access change',
    );
  await assertCollectionEditor(cloudDb, actor.id, sourceId);
  const excluded = ids(body.excludedBookIds ?? []);
  const selected =
    body.allInCollection === true ? undefined : ids(body.bookIds);
  const rows = await cloudDb
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        eq(books.collectionId, sourceId),
        selected ? inArray(books.id, selected) : undefined,
        excluded.length ? notInArray(books.id, excluded) : undefined,
      ),
    );
  if (selected && rows.length !== selected.length)
    throw new CollectionError(
      409,
      'The source selection changed. Review it again.',
    );
  const moved = await moveCollectionBooks(
    cloudDb,
    actor.id,
    rows.map((row) => row.id),
    body.targetCollectionId,
    sourceId,
  );
  return { success: true, data: { moved } };
});
