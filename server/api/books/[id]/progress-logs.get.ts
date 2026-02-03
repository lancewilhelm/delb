import { and, desc, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookProgressLog,
} from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

function clampInt(
  input: unknown,
  opts: { min: number; max: number; fallback: number },
): number {
  const n = Number.parseInt((input ?? '').toString(), 10);
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, n));
}

/**
 * GET /api/books/:id/progress-logs
 *
 * Returns progress log entries for the authenticated user.
 *
 * Query params:
 * - limit=<n> (default 50, max 200)
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books/:id/progress-logs');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;
  const bookId = getRouterParam(event, 'id');
  if (!bookId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  }

  const q = getQuery(event) as { limit?: string };
  const limit = clampInt(q.limit, { min: 1, max: 200, fallback: 50 });

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

    if (!visible[0]) {
      throw createError({ statusCode: 404, statusMessage: 'Book not found' });
    }

    const logs = await cloudDb
      .select({
        id: userBookProgressLog.id,
        progressPercent: userBookProgressLog.progressPercent,
        pageNumber: userBookProgressLog.pageNumber,
        location: userBookProgressLog.location,
        source: userBookProgressLog.source,
        occurredAt: userBookProgressLog.occurredAt,
        createdAt: userBookProgressLog.createdAt,
      })
      .from(userBookProgressLog)
      .where(
        and(
          eq(userBookProgressLog.userId, userId),
          eq(userBookProgressLog.bookId, bookId),
        ),
      )
      .orderBy(desc(userBookProgressLog.occurredAt))
      .limit(limit);

    return { success: true, data: { logs } };
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(error, 'GET /api/books/:id/progress-logs: Error fetching logs');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch progress logs',
    });
  }
});
