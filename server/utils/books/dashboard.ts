import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, asc, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookReadingPosition,
  userBookStatus,
} from '../../../app/utils/db/schema';
import type {
  DashboardData,
  DashboardShelf,
} from '../../../shared/types/dashboard';

function calendarDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function visibleBooks({
  userId,
  collectionId,
}: {
  userId: string;
  collectionId?: string;
}) {
  return sql`EXISTS (SELECT 1 FROM ${collectionBooks}
    INNER JOIN ${collectionMembers} ON ${collectionMembers.collectionId} = ${collectionBooks.collectionId}
    WHERE ${collectionBooks.bookId} = ${books.id} AND ${collectionMembers.userId} = ${userId}
    ${collectionId ? sql`AND ${collectionBooks.collectionId} = ${collectionId}` : sql``})`;
}

export async function getDashboard(
  db: LibSQLDatabase,
  options: {
    userId: string;
    collectionId?: string;
    shelf: DashboardShelf;
    offset?: number;
  },
): Promise<DashboardData> {
  const { userId, shelf, offset = 0 } = options;
  const visible = visibleBooks(options);
  const [counts] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      none: sql<number>`COUNT(CASE WHEN ${userBookStatus.status} IS NULL THEN 1 END)`,
      to_be_read: sql<number>`COUNT(CASE WHEN ${userBookStatus.status} = 'to_be_read' THEN 1 END)`,
      reading: sql<number>`COUNT(CASE WHEN ${userBookStatus.status} = 'reading' THEN 1 END)`,
      finished: sql<number>`COUNT(CASE WHEN ${userBookStatus.status} = 'finished' THEN 1 END)`,
      dnf: sql<number>`COUNT(CASE WHEN ${userBookStatus.status} = 'dnf' THEN 1 END)`,
    })
    .from(books)
    .leftJoin(
      userBookStatus,
      and(
        eq(userBookStatus.bookId, books.id),
        eq(userBookStatus.userId, userId),
      ),
    )
    .where(visible);

  const filters = {
    reading: eq(userBookStatus.status, 'reading'),
    recent: and(
      eq(userBookStatus.status, 'finished'),
      isNotNull(userBookStatus.finishedAt),
    ),
  };
  const order: Record<DashboardShelf, SQL[]> = {
    reading: [
      desc(userBookReadingPosition.updatedAt),
      desc(userBookStatus.updatedAt),
      asc(books.id),
    ],
    recent: [desc(userBookStatus.finishedAt), asc(books.id)],
  };
  const pageSize = 12;
  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      coverImagePath: books.coverImagePath,
      updatedAt: books.updatedAt,
      progress: userBookReadingPosition.progress,
      finishedAt: userBookStatus.finishedAt,
    })
    .from(books)
    .leftJoin(
      userBookStatus,
      and(
        eq(userBookStatus.bookId, books.id),
        eq(userBookStatus.userId, userId),
      ),
    )
    .leftJoin(
      userBookReadingPosition,
      and(
        eq(userBookReadingPosition.bookId, books.id),
        eq(userBookReadingPosition.userId, userId),
      ),
    )
    .where(and(visible, filters[shelf]))
    .orderBy(...order[shelf])
    .limit(pageSize + 1)
    .offset(offset);

  return {
    counts: counts ?? {
      total: 0,
      none: 0,
      to_be_read: 0,
      reading: 0,
      finished: 0,
      dnf: 0,
    },
    shelf: {
      kind: shelf,
      books: rows.slice(0, pageSize).map((book) => ({
        id: book.id,
        title: book.title,
        coverImagePath: book.coverImagePath,
        updatedAt: book.updatedAt.toISOString(),
        progress: book.progress,
        finishedDate: book.finishedAt ? calendarDate(book.finishedAt) : null,
      })),
      nextOffset: rows.length > pageSize ? offset + pageSize : null,
    },
  };
}
