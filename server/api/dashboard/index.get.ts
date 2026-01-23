import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookReadingPosition,
  userBookStatus,
} from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

type FetchBook = {
  id: string;
  title: string;
  coverImagePath?: string | null;
  progress?: number | null;
};

export default defineEventHandler(async (event) => {
  logger.debug('GET /api/dashboard');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const userId = session.user.id;

  const q = getQuery(event) as { collectionId?: string };
  const collectionId = (q.collectionId ?? '').toString().trim();

  // Find collections the user is a member of
  const memberships = await cloudDb
    .select({ collectionId: collectionMembers.collectionId })
    .from(collectionMembers)
    .where(eq(collectionMembers.userId, userId));

  const memberCollectionIds = Array.from(
    new Set(memberships.map((m) => m.collectionId)),
  ).filter(Boolean);

  if (!memberCollectionIds.length) {
    return {
      success: true,
      data: {
        counts: {
          total: 0,
          none: 0,
          to_be_read: 0,
          reading: 0,
          finished: 0,
          dnf: 0,
        },
        reading: { books: [] as FetchBook[] },
      },
    };
  }

  const targetCollectionIds = collectionId
    ? memberCollectionIds.includes(collectionId)
      ? [collectionId]
      : []
    : memberCollectionIds;

  if (!targetCollectionIds.length) {
    return {
      success: true,
      data: {
        counts: {
          total: 0,
          none: 0,
          to_be_read: 0,
          reading: 0,
          finished: 0,
          dnf: 0,
        },
        reading: { books: [] as FetchBook[] },
      },
    };
  }

  // Counts across all visible books (deduped by books.id).
  const countsRows = await cloudDb
    .select({
      total: sql<number>`COUNT(DISTINCT ${books.id})`,
      none: sql<number>`COUNT(DISTINCT CASE WHEN ${userBookStatus.status} IS NULL THEN ${books.id} END)`,
      to_be_read: sql<number>`COUNT(DISTINCT CASE WHEN ${userBookStatus.status} = 'to_be_read' THEN ${books.id} END)`,
      reading: sql<number>`COUNT(DISTINCT CASE WHEN ${userBookStatus.status} = 'reading' THEN ${books.id} END)`,
      finished: sql<number>`COUNT(DISTINCT CASE WHEN ${userBookStatus.status} = 'finished' THEN ${books.id} END)`,
      dnf: sql<number>`COUNT(DISTINCT CASE WHEN ${userBookStatus.status} = 'dnf' THEN ${books.id} END)`,
    })
    .from(books)
    .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
    .leftJoin(
      userBookStatus,
      and(eq(userBookStatus.bookId, books.id), eq(userBookStatus.userId, userId)),
    )
    .where(inArray(collectionBooks.collectionId, targetCollectionIds));

  const counts = countsRows?.[0] ?? {
    total: 0,
    none: 0,
    to_be_read: 0,
    reading: 0,
    finished: 0,
    dnf: 0,
  };

  // "Continue reading" list (best-effort, limited).
  const readingRows = await cloudDb
    .select({
      id: books.id,
      title: books.title,
      coverImagePath: books.coverImagePath,
      progress: userBookReadingPosition.progress,
    })
    .from(books)
    .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
    .innerJoin(
      userBookStatus,
      and(
        eq(userBookStatus.bookId, books.id),
        eq(userBookStatus.userId, userId),
        eq(userBookStatus.status, 'reading'),
      ),
    )
    .leftJoin(
      userBookReadingPosition,
      and(
        eq(userBookReadingPosition.bookId, books.id),
        eq(userBookReadingPosition.userId, userId),
      ),
    )
    .where(inArray(collectionBooks.collectionId, targetCollectionIds))
    .groupBy(books.id)
    .orderBy(desc(userBookReadingPosition.updatedAt), desc(userBookStatus.updatedAt))
    .limit(12);

  const readingBooks: FetchBook[] = readingRows.map((r) => ({
    id: r.id,
    title: r.title,
    coverImagePath: r.coverImagePath,
    progress: r.progress ?? null,
  }));

  return {
    success: true,
    data: {
      counts,
      reading: { books: readingBooks },
    },
  };
});

