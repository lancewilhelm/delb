import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { books, bookSpines, collectionMembers } from '~~/server/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import type { SelectedSeriesSpine } from '~~/shared/spine-series-references';

export async function findSeriesSpines(
  userId: string,
  bookId: string,
  selected?: SelectedSeriesSpine[],
) {
  const [book] = await cloudDb
    .select({ seriesId: books.seriesId, seriesIndex: books.seriesIndex })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!book?.seriesId) {
    if (selected?.length)
      throw createError({
        statusCode: 409,
        statusMessage:
          'Series references changed. Reload them before generating.',
      });
    return [];
  }
  if (selected && !selected.length) return [];
  const rows = await cloudDb
    .select({
      bookId: books.id,
      title: books.title,
      seriesIndex: books.seriesIndex,
      revision: bookSpines.revision,
      imageBase64: sql<string>`case when ${!!selected} then ${bookSpines.imageBase64} else '' end`,
    })
    .from(books)
    .innerJoin(bookSpines, eq(bookSpines.bookId, books.id))
    .innerJoin(
      collectionMembers,
      and(
        eq(collectionMembers.collectionId, books.collectionId),
        eq(collectionMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(books.seriesId, book.seriesId),
        ne(books.id, bookId),
        selected
          ? inArray(
              books.id,
              selected.map((item) => item.bookId),
            )
          : undefined,
      ),
    )
    .orderBy(
      asc(sql`case when ${books.seriesIndex} is null then 1 else 0 end`),
      asc(
        book.seriesIndex === null
          ? books.seriesIndex
          : sql`abs(${books.seriesIndex} - ${book.seriesIndex})`,
      ),
      asc(books.seriesIndex),
      asc(books.id),
    );
  if (
    selected &&
    (rows.length !== selected.length ||
      selected.some(
        (item) =>
          !rows.some(
            (row) =>
              row.bookId === item.bookId && row.revision === item.revision,
          ),
      ))
  )
    throw createError({
      statusCode: 409,
      statusMessage:
        'Series references changed or are no longer accessible. Reload them before generating.',
    });
  return rows;
}
