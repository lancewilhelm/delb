import { and, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookReadingPosition,
} from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

/**
 * GET /api/books/:id/reading-position
 *
 * Returns the authenticated user's reading position for a book.
 *
 * Access control:
 * - Requires authentication
 * - Uses the same visibility model as GET /api/books/:id
 *
 * Response:
 * - { success: true, data: { location: string | null, progress: number | null } }
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books/:id/reading-position');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;

  const bookId = getRouterParam(event, 'id');
  if (!bookId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  }

  try {
    const memberships = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, userId));

    const memberCollectionIds = Array.from(
      new Set(memberships.map((m) => m.collectionId)),
    ).filter(Boolean);

    if (!memberCollectionIds.length) {
      throw createError({ statusCode: 404, statusMessage: 'Book not found' });
    }

    const visible = await cloudDb
      .select({ id: books.id })
      .from(books)
      .innerJoin(
        collectionBooks,
        and(eq(collectionBooks.bookId, books.id), eq(books.id, bookId)),
      )
      .where(inArray(collectionBooks.collectionId, memberCollectionIds))
      .limit(1);

    if (!visible[0]?.id) {
      throw createError({ statusCode: 404, statusMessage: 'Book not found' });
    }

    const row =
      (
        await cloudDb
          .select({
            location: userBookReadingPosition.location,
            progress: userBookReadingPosition.progress,
          })
          .from(userBookReadingPosition)
          .where(
            and(
              eq(userBookReadingPosition.userId, userId),
              eq(userBookReadingPosition.bookId, bookId),
            ),
          )
          .limit(1)
      )[0] ?? null;

    return {
      success: true,
      data: {
        location: row?.location ?? null,
        progress: row?.progress ?? null,
      },
    };
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(
      error,
      'GET /api/books/:id/reading-position: Error fetching reading position',
    );
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch reading position',
    });
  }
});
