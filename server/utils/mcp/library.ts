import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
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
  userBookRationale,
  type UserBookStatusValue,
} from '~/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { visibleBook } from '~~/server/utils/books/visibility';
import { transitionBookStatuses } from '~~/server/utils/books/status-transition';
import { changeShelfBooks, listShelves } from '~~/server/utils/shelves/model';
import { authorizeWrite, type McpActor } from './connections';
import { writeRationale } from '~~/server/utils/books/tbr';
import { parseBookId, parseReaderId } from '~~/server/utils/books/ids';
import { metadataVersion } from '~~/server/utils/books/metadata-snapshot';
import {
  updateBookMetadata,
  type PutBookBody,
} from '~~/server/utils/books/update-metadata';

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
    statuses?: Array<UserBookStatusValue | 'none'>;
  },
) {
  const escaped = input.query.replace(/[\\%_]/g, '\\$&');
  const term = `%${escaped}%`;
  const statusValues =
    input.statuses?.filter(
      (value): value is UserBookStatusValue => value !== 'none',
    ) ?? [];
  const statusFilter = input.statuses?.length
    ? or(
        statusValues.length
          ? inArray(userBookStatus.status, statusValues)
          : undefined,
        input.statuses.includes('none')
          ? isNull(userBookStatus.status)
          : undefined,
      )
    : undefined;
  const rows = await cloudDb
    .select({
      id: books.id,
      title: books.title,
      published: books.published,
      status: userBookStatus.status,
      startedAt: userBookStatus.startedAt,
      finishedAt: userBookStatus.finishedAt,
      dnfAt: userBookStatus.dnfAt,
      tbrRank: userBookStatus.tbrRank,
      note: userBookRationale.text,
    })
    .from(books)
    .leftJoin(
      userBookStatus,
      and(
        eq(userBookStatus.bookId, books.id),
        eq(userBookStatus.userId, actor.userId),
      ),
    )
    .leftJoin(
      userBookRationale,
      and(
        eq(userBookRationale.bookId, books.id),
        eq(userBookRationale.userId, actor.userId),
      ),
    )
    .where(
      and(
        visibleBook(actor.userId),
        statusFilter,
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
  return cloudDb.transaction(async (tx) => {
    const [book] = await tx
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
        startedAt: userBookStatus.startedAt,
        finishedAt: userBookStatus.finishedAt,
        dnfAt: userBookStatus.dnfAt,
        tbrRank: userBookStatus.tbrRank,
        note: userBookRationale.text,
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
      .leftJoin(
        userBookRationale,
        and(
          eq(userBookRationale.bookId, books.id),
          eq(userBookRationale.userId, actor.userId),
        ),
      )
      .where(and(eq(books.id, bookId), visibleBook(actor.userId)))
      .limit(1);
    if (!book)
      throw createError({ statusCode: 404, statusMessage: 'Book not found.' });
    const [authorRows, identifiers, tagRows] = await Promise.all([
      tx
        .select({ name: authors.name })
        .from(bookAuthors)
        .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
        .where(eq(bookAuthors.bookId, bookId))
        .orderBy(asc(bookAuthors.position)),
      tx
        .select({ type: bookIdentifiers.type, value: bookIdentifiers.value })
        .from(bookIdentifiers)
        .where(eq(bookIdentifiers.bookId, bookId))
        .limit(101),
      tx
        .select({ name: tags.name })
        .from(bookTags)
        .innerJoin(tags, eq(tags.id, bookTags.tagId))
        .where(eq(bookTags.bookId, bookId))
        .limit(101),
    ]);
    return {
      ...book,
      metadataVersion: await metadataVersion(tx, bookId),
      description: book.description?.slice(0, 12000) ?? null,
      authors: authorRows.map((a) => a.name),
      descriptionTruncated: (book.description?.length ?? 0) > 12000,
      identifiers: identifiers.slice(0, 100),
      identifiersTruncated: identifiers.length > 100,
      tags: tagRows.slice(0, 100).map((t) => t.name),
      tagsTruncated: tagRows.length > 100,
    };
  });
}

export async function myShelves(actor: McpActor) {
  return listShelves(actor.userId);
}
export async function setStatus(
  actor: McpActor,
  bookId: string,
  change: {
    status?: UserBookStatusValue | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    dnfAt?: Date | null;
    tbrRank?: number;
  },
) {
  const result = await transitionBookStatuses(cloudDb, {
    userId: actor.userId,
    bookIds: [bookId],
    now: new Date(),
    change,
    authorize: (tx) => authorizeWrite(tx, actor),
  });
  if (!result.rows[0])
    throw createError({ statusCode: 404, statusMessage: 'Book not found.' });
  return result.rows[0];
}

export async function listMyTbr(
  actor: McpActor,
  after: string | undefined,
  limit: number,
) {
  return cloudDb.transaction(async (tx) => {
    const scope = and(
      eq(userBookStatus.userId, actor.userId),
      eq(userBookStatus.status, 'to_be_read'),
      isNotNull(userBookStatus.tbrRank),
      visibleBook(actor.userId),
    );
    let cursor: { id: string; rank: number | null } | undefined;
    if (after) {
      [cursor] = await tx
        .select({ id: books.id, rank: userBookStatus.tbrRank })
        .from(books)
        .innerJoin(userBookStatus, eq(userBookStatus.bookId, books.id))
        .where(and(scope, eq(books.id, after)))
        .limit(1);
      if (!cursor || cursor.rank === null)
        throw createError({
          statusCode: 400,
          statusMessage: 'TBR cursor is no longer available. Start again.',
        });
    }
    const [total] = await tx
      .select({ value: count() })
      .from(books)
      .innerJoin(userBookStatus, eq(userBookStatus.bookId, books.id))
      .where(scope);
    const rows = await tx
      .select({
        id: books.id,
        title: books.title,
        rank: userBookStatus.tbrRank,
        note: userBookRationale.text,
      })
      .from(books)
      .innerJoin(userBookStatus, eq(userBookStatus.bookId, books.id))
      .leftJoin(
        userBookRationale,
        and(
          eq(userBookRationale.bookId, books.id),
          eq(userBookRationale.userId, actor.userId),
        ),
      )
      .where(
        and(
          scope,
          cursor && cursor.rank !== null
            ? or(
                gt(userBookStatus.tbrRank, cursor.rank),
                and(
                  eq(userBookStatus.tbrRank, cursor.rank),
                  gt(books.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(userBookStatus.tbrRank), asc(books.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const items = await Promise.all(
      page.map(async (book) => ({
        ...book,
        note: book.note ?? '',
        authors: await tx
          .select({ id: authors.id, name: authors.name })
          .from(bookAuthors)
          .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
          .where(eq(bookAuthors.bookId, book.id))
          .orderBy(asc(bookAuthors.position), asc(authors.id)),
      })),
    );
    return {
      items,
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      count: total?.value ?? 0,
    };
  });
}

export async function setTbrNote(
  actor: McpActor,
  bookId: string,
  note: string,
) {
  const saved = await writeRationale(cloudDb, {
    userId: parseReaderId(actor.userId),
    bookId: parseBookId(bookId),
    text: note.trim(),
    authorize: (tx) => authorizeWrite(tx, actor),
  });
  return { bookId, note: saved };
}

export async function editMetadata(
  actor: McpActor,
  bookId: string,
  expectedVersion: string,
  changes: PutBookBody,
) {
  const result = await updateBookMetadata({
    userId: actor.userId,
    id: bookId,
    body: changes,
    expectedVersion,
    authorize: async (tx) => {
      await authorizeWrite(tx, actor, 'metadata');
      if (changes.description !== undefined) {
        const [row] = await tx
          .select({ description: books.description })
          .from(books)
          .where(eq(books.id, bookId))
          .limit(1);
        if ((row?.description?.length ?? 0) > 12000)
          throw createError({
            statusCode: 400,
            statusMessage:
              'Description exceeds the MCP read limit. Edit it in Delb instead.',
          });
      }
      if (changes.tags !== undefined) {
        const [row] = await tx
          .select({ value: count() })
          .from(bookTags)
          .where(eq(bookTags.bookId, bookId));
        if ((row?.value ?? 0) > 100)
          throw createError({
            statusCode: 400,
            statusMessage:
              'This book has more tags than MCP can show. Edit tags in Delb instead.',
          });
      }
      if (changes.identifiers !== undefined) {
        const [row] = await tx
          .select({ value: count() })
          .from(bookIdentifiers)
          .where(eq(bookIdentifiers.bookId, bookId));
        if ((row?.value ?? 0) > 100)
          throw createError({
            statusCode: 400,
            statusMessage:
              'This book has more identifiers than MCP can show. Edit identifiers in Delb instead.',
          });
      }
    },
  });
  return {
    book: await getBook(actor, bookId),
    storageWarning: result.storageWarning,
  };
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
