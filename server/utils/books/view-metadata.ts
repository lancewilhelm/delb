import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  bookTags,
  tags,
  bookIdentifiers,
  bookFiles,
  bookRatings,
  userBookStatus,
} from '../../../app/utils/db/schema';
import type { cloudDb } from '../db/cloud';

/** Enrich only the page already authorized by the caller; personal values belong to this user. */
export async function enrichBookViewPage<T extends { id: string }>(
  db: typeof cloudDb,
  page: T[],
  userId: string,
) {
  if (!page.length) return [];
  const ids = page.map((book) => book.id);
  const [tagRows, identifiers, files, ratings, statuses] = await Promise.all([
    db
      .select({ bookId: bookTags.bookId, id: tags.id, name: tags.name })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(inArray(bookTags.bookId, ids))
      .orderBy(asc(tags.name), asc(tags.id)),
    db
      .select()
      .from(bookIdentifiers)
      .where(inArray(bookIdentifiers.bookId, ids))
      .orderBy(asc(bookIdentifiers.type)),
    db
      .select({ bookId: bookFiles.bookId, format: bookFiles.format })
      .from(bookFiles)
      .where(inArray(bookFiles.bookId, ids))
      .orderBy(asc(bookFiles.format)),
    db
      .select({ bookId: bookRatings.bookId, rating: bookRatings.rating })
      .from(bookRatings)
      .where(
        and(inArray(bookRatings.bookId, ids), eq(bookRatings.userId, userId)),
      ),
    db
      .select({ bookId: userBookStatus.bookId, status: userBookStatus.status })
      .from(userBookStatus)
      .where(
        and(
          inArray(userBookStatus.bookId, ids),
          eq(userBookStatus.userId, userId),
        ),
      ),
  ]);
  function groupByBook<T extends { bookId: string }>(rows: T[]) {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
      const group = groups.get(row.bookId) ?? [];
      group.push(row);
      groups.set(row.bookId, group);
    }
    return groups;
  }
  const tagsByBook = groupByBook(tagRows);
  const identifiersByBook = groupByBook(identifiers);
  const filesByBook = groupByBook(files);
  const ratingsByBook = new Map(ratings.map((row) => [row.bookId, row.rating]));
  const statusByBook = new Map(statuses.map((row) => [row.bookId, row.status]));
  return page.map((book) => ({
    ...book,
    tags: (tagsByBook.get(book.id) ?? []).map(({ id, name }) => ({ id, name })),
    identifiers: (identifiersByBook.get(book.id) ?? []).map(
      ({ type, value }) => ({ type, value }),
    ),
    formats: [
      ...new Set(
        (filesByBook.get(book.id) ?? []).map((row) => row.format.toLowerCase()),
      ),
    ],
    rating: ratingsByBook.get(book.id) ?? null,
    status: statusByBook.get(book.id) ?? null,
  }));
}
