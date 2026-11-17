import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import {
  authors,
  bookAuthors,
  bookIdentifiers,
  books,
  bookTags,
  collectionMembers,
  collections,
  personalShelfBooks,
  personalShelves,
  publishers,
  series,
  tags,
  userBookStatus,
  type UserBookStatusValue,
} from '~/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { visibleBook } from '~~/server/utils/books/visibility';
import { transitionBookStatuses } from '~~/server/utils/books/status-transition';
import { changeShelfBooks, listShelves } from '~~/server/utils/shelves/model';
import { authorizeWrite, type McpActor } from './connections';

export async function listCollections(actor: McpActor) {
  return cloudDb
    .select({
      id: collections.id,
      name: collections.name,
      role: collectionMembers.role,
    })
    .from(collections)
    .innerJoin(
      collectionMembers,
      eq(collectionMembers.collectionId, collections.id),
    )
    .where(eq(collectionMembers.userId, actor.userId))
    .orderBy(asc(collections.name));
}

export async function searchBooks(
  actor: McpActor,
  input: {
    query: string;
    collectionId?: string;
    after?: string;
    limit: number;
    shelfId?: string;
  },
) {
  const escaped = input.query.replace(/[\\%_]/g, '\\$&');
  const term = `%${escaped}%`;
  const rows = await cloudDb
    .select({
      id: books.id,
      title: books.title,
      published: books.published,
      status: userBookStatus.status,
    })
    .from(books)
    .leftJoin(
      userBookStatus,
      and(
        eq(userBookStatus.bookId, books.id),
        eq(userBookStatus.userId, actor.userId),
      ),
    )
    .where(
      and(
        visibleBook(actor.userId),
        input.collectionId
          ? eq(books.collectionId, input.collectionId)
          : undefined,
        input.after ? gt(books.id, input.after) : undefined,
        input.shelfId
          ? sql`EXISTS (SELECT 1 FROM ${personalShelfBooks} INNER JOIN ${personalShelves} ON ${personalShelves.id} = ${personalShelfBooks.shelfId} WHERE ${personalShelfBooks.bookId} = ${books.id} AND ${personalShelves.id} = ${input.shelfId} AND ${personalShelves.ownerId} = ${actor.userId})`
          : undefined,
        input.query
          ? or(
              sql`${books.title} LIKE ${term} ESCAPE '\\'`,
              sql`EXISTS (SELECT 1 FROM ${bookAuthors} INNER JOIN ${authors} ON ${authors.id} = ${bookAuthors.authorId} WHERE ${bookAuthors.bookId} = ${books.id} AND ${authors.name} LIKE ${term} ESCAPE '\\')`,
              sql`EXISTS (SELECT 1 FROM ${bookIdentifiers} WHERE ${bookIdentifiers.bookId} = ${books.id} AND ${bookIdentifiers.value} LIKE ${term} ESCAPE '\\')`,
            )
          : undefined,
      ),
    )
    .orderBy(asc(books.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const items = await Promise.all(
    page.map(async (book) => ({
      ...book,
      authors: (
        await cloudDb
          .select({ name: authors.name })
          .from(bookAuthors)
          .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
          .where(eq(bookAuthors.bookId, book.id))
          .orderBy(asc(bookAuthors.position))
      ).map((a) => a.name),
    })),
  );
  return {
    items,
    nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getBook(actor: McpActor, bookId: string) {
  const [book] = await cloudDb
    .select({
      id: books.id,
      title: books.title,
      description: books.description,
      published: books.published,
      language: books.language,
      pages: books.pages,
      hasPhysicalCopy: books.hasPhysicalCopy,
      hasAudiobookCopy: books.hasAudiobookCopy,
      publisher: publishers.name,
      series: series.name,
      seriesIndex: books.seriesIndex,
      status: userBookStatus.status,
    })
    .from(books)
    .leftJoin(publishers, eq(publishers.id, books.publisherId))
    .leftJoin(series, eq(series.id, books.seriesId))
    .leftJoin(
      userBookStatus,
      and(
        eq(userBookStatus.bookId, books.id),
        eq(userBookStatus.userId, actor.userId),
      ),
    )
    .where(and(eq(books.id, bookId), visibleBook(actor.userId)))
    .limit(1);
  if (!book)
    throw createError({ statusCode: 404, statusMessage: 'Book not found.' });
  const [authorRows, identifiers, tagRows] = await Promise.all([
    cloudDb
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, bookId))
      .orderBy(asc(bookAuthors.position)),
    cloudDb
      .select({ type: bookIdentifiers.type, value: bookIdentifiers.value })
      .from(bookIdentifiers)
      .where(eq(bookIdentifiers.bookId, bookId))
      .limit(100),
    cloudDb
      .select({ name: tags.name })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(eq(bookTags.bookId, bookId))
      .limit(100),
  ]);
  return {
    ...book,
    description: book.description?.slice(0, 12000) ?? null,
    authors: authorRows.map((a) => a.name),
    identifiers,
    tags: tagRows.map((t) => t.name),
  };
}

export async function myShelves(actor: McpActor) {
  return listShelves(actor.userId);
}
export async function setStatus(
  actor: McpActor,
  bookId: string,
  status: UserBookStatusValue | null,
) {
  const result = await transitionBookStatuses(cloudDb, {
    userId: actor.userId,
    bookIds: [bookId],
    now: new Date(),
    change: { status },
    authorize: (tx) => authorizeWrite(tx, actor),
  });
  if (!result.rows[0])
    throw createError({ statusCode: 404, statusMessage: 'Book not found.' });
  return result.rows[0];
}
export async function setShelf(
  actor: McpActor,
  shelfId: string,
  bookId: string,
  present: boolean,
) {
  await changeShelfBooks(
    actor.userId,
    shelfId,
    [bookId],
    present ? 'add' : 'remove',
    (tx) => authorizeWrite(tx, actor),
  );
  return { shelfId, bookId, present };
}
