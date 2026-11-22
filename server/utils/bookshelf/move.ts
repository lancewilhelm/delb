import { eq } from 'drizzle-orm';
import { collectionBookshelves } from '~~/server/utils/db/schema';
import { emptyBookshelf, parseBookshelf } from '~~/shared/bookshelf';
import type { cloudDb } from '~~/server/utils/db/cloud';

type Db = Parameters<Parameters<typeof cloudDb.transaction>[0]>[0];

// Called inside the same collection lock and transaction as the book move.
export async function recordShelfBookMove(
  db: Db,
  collectionId: string,
  removed: ReadonlySet<string>,
) {
  const [stored] = await db
    .select()
    .from(collectionBookshelves)
    .where(eq(collectionBookshelves.collectionId, collectionId))
    .limit(1);
  const arrangement = stored
    ? parseBookshelf(stored.arrangement)
    : emptyBookshelf();
  if (!arrangement)
    throw new Error('The collection bookshelf could not be read.');
  for (const bookcase of arrangement.bookcases)
    for (const shelf of bookcase.shelves) {
      for (const item of shelf.items)
        item.books = item.books.filter((book) => !removed.has(book.id));
      shelf.items = shelf.items.filter((item) => item.books.length > 0);
    }
  const revision = (stored?.revision ?? 0) + 1;
  await db
    .insert(collectionBookshelves)
    .values({ collectionId, revision, arrangement })
    .onConflictDoUpdate({
      target: collectionBookshelves.collectionId,
      set: { revision, arrangement },
    });
}
