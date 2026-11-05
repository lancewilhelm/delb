import { and, asc, eq, isNotNull } from 'drizzle-orm';
import {
  authors,
  bookAuthors,
  books,
  userBookRationale,
  userBookStatus,
} from '../../../app/utils/db/schema';
import type { TbrBook } from '../../../app/types/tbr';
import type { cloudDb } from '../db/cloud';
import { visibleBook } from './visibility';
import { buildBookCoverUrl } from './cover-url';
import type { BookId, ReaderId } from './ids';

type RationaleTarget = { userId: ReaderId; bookId: BookId };

export async function getTbrQueue(db: typeof cloudDb, userId: string) {
  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      description: books.description,
      cover: books.coverImagePath,
      updatedAt: books.updatedAt,
      rank: userBookStatus.tbrRank,
      rationale: userBookRationale.text,
      authorId: authors.id,
      authorName: authors.name,
    })
    .from(books)
    .innerJoin(
      userBookStatus,
      and(
        eq(userBookStatus.bookId, books.id),
        eq(userBookStatus.userId, userId),
      ),
    )
    .leftJoin(
      userBookRationale,
      and(
        eq(userBookRationale.bookId, books.id),
        eq(userBookRationale.userId, userId),
      ),
    )
    .leftJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
    .leftJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(
      and(
        eq(userBookStatus.status, 'to_be_read'),
        isNotNull(userBookStatus.tbrRank),
        visibleBook(userId),
      ),
    )
    .orderBy(
      asc(userBookStatus.tbrRank),
      asc(bookAuthors.position),
      asc(authors.id),
    );
  const byId = new Map<string, TbrBook>();
  for (const row of rows) {
    if (row.rank === null) continue;
    let book = byId.get(row.id);
    if (!book) {
      book = {
        id: row.id,
        title: row.title,
        description: row.description,
        coverThumbnailUrl: row.cover
          ? buildBookCoverUrl({
              bookId: row.id,
              updatedAt: row.updatedAt,
              variant: 'thumb',
            })
          : null,
        rank: row.rank,
        rationale: row.rationale ?? '',
        authors: [],
      };
      byId.set(row.id, book);
    }
    if (row.authorId && row.authorName)
      book.authors.push({ id: row.authorId, name: row.authorName });
  }
  const queue = [...byId.values()];
  return { books: queue, count: queue.length };
}

class BookNotFoundError extends Error {
  statusCode = 404;
  constructor() {
    super('Book not found');
  }
}

export async function readRationale(
  db: typeof cloudDb,
  { userId, bookId }: RationaleTarget,
) {
  return db.transaction(async (tx) => {
    const [book] = await tx
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, bookId), visibleBook(userId)));
    if (!book) throw new BookNotFoundError();
    const [note] = await tx
      .select({ text: userBookRationale.text })
      .from(userBookRationale)
      .where(
        and(
          eq(userBookRationale.userId, userId),
          eq(userBookRationale.bookId, bookId),
        ),
      );
    return note?.text ?? '';
  });
}

export async function writeRationale(
  db: typeof cloudDb,
  { userId, bookId, text }: RationaleTarget & { text: string },
) {
  return db.transaction(async (tx) => {
    const [book] = await tx
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, bookId), visibleBook(userId)));
    if (!book) throw new BookNotFoundError();
    await tx
      .insert(userBookRationale)
      .values({ userId, bookId, text })
      .onConflictDoUpdate({
        target: [userBookRationale.userId, userBookRationale.bookId],
        set: { text },
      });
    return text;
  });
}
