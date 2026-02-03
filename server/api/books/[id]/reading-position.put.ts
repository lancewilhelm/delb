import { and, desc, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookPreferences,
  userBookProgressLog,
  userBookReadingPosition,
} from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

/**
 * PUT /api/books/:id/reading-position
 *
 * Updates (or clears) the authenticated user's reading position for a book.
 *
 * Body:
 * - { location: string | null, progress?: number | null }
 *
 * Clearing:
 * - send `location: null` (or empty string) to clear/delete the position
 *
 * Response:
 * - { success: true, data: { location: string | null, progress: number | null } }
 */
export default defineEventHandler(async (event) => {
  logger.debug('PUT /api/books/:id/reading-position');
  const PROGRESS_LOG_MIN_DELTA = 1;

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const userId = session.user.id;

  const bookId = getRouterParam(event, 'id');
  if (!bookId) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Missing book id' };
  }

  const body = (await readBody(event).catch(() => null)) as {
    location?: unknown;
    progress?: unknown;
  } | null;

  const rawLocation = body?.location;
  const rawProgress = body?.progress;

  const wantsClear =
    rawLocation === null || rawLocation === undefined || rawLocation === '';

  let location: string | null = null;
  if (!wantsClear) {
    if (typeof rawLocation !== 'string') {
      setResponseStatus(event, 400);
      return {
        success: false,
        message: 'Invalid location (must be a string or null to clear).',
      };
    }
    location = rawLocation;
  }

  let progress: number | null = null;
  if (!wantsClear && rawProgress !== undefined && rawProgress !== null) {
    const parsed =
      typeof rawProgress === 'number'
        ? rawProgress
        : typeof rawProgress === 'string'
          ? Number(rawProgress)
          : NaN;

    if (!Number.isFinite(parsed)) {
      setResponseStatus(event, 400);
      return {
        success: false,
        message: 'Invalid progress (must be a number 0..100).',
      };
    }

    if (parsed < 0 || parsed > 100) {
      setResponseStatus(event, 400);
      return {
        success: false,
        message: 'Invalid progress (must be between 0 and 100).',
      };
    }

    progress = parsed;
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
      setResponseStatus(event, 404);
      return { success: false, message: 'Book not found' };
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
      setResponseStatus(event, 404);
      return { success: false, message: 'Book not found' };
    }

    if (wantsClear) {
      await cloudDb
        .delete(userBookReadingPosition)
        .where(
          and(
            eq(userBookReadingPosition.userId, userId),
            eq(userBookReadingPosition.bookId, bookId),
          ),
        );

      return { success: true, data: { location: null, progress: null } };
    }

    const updatedAt = new Date();

    const updateRes = await cloudDb
      .update(userBookReadingPosition)
      .set({ location: location ?? '', progress, updatedAt })
      .where(
        and(
          eq(userBookReadingPosition.userId, userId),
          eq(userBookReadingPosition.bookId, bookId),
        ),
      );

    const rowsAffected =
      typeof updateRes === 'number'
        ? updateRes
        : ((updateRes as { rowsAffected?: number })?.rowsAffected ?? 0);

    if (!rowsAffected) {
      await cloudDb.insert(userBookReadingPosition).values({
        userId,
        bookId,
        location: location ?? '',
        progress,
        updatedAt,
      });
    }

    if (progress != null) {
      try {
        const pref =
          (
            await cloudDb
              .select({
                progressSyncEnabled: userBookPreferences.progressSyncEnabled,
              })
              .from(userBookPreferences)
              .where(
                and(
                  eq(userBookPreferences.userId, userId),
                  eq(userBookPreferences.bookId, bookId),
                ),
              )
              .limit(1)
          )[0] ?? null;

        if (pref?.progressSyncEnabled) {
          const latestLog =
            (
              await cloudDb
                .select({
                  progressPercent: userBookProgressLog.progressPercent,
                  occurredAt: userBookProgressLog.occurredAt,
                })
                .from(userBookProgressLog)
                .where(
                  and(
                    eq(userBookProgressLog.userId, userId),
                    eq(userBookProgressLog.bookId, bookId),
                  ),
                )
                .orderBy(desc(userBookProgressLog.occurredAt))
                .limit(1)
            )[0] ?? null;

          const shouldLog =
            !latestLog ||
            Math.abs(Number(latestLog.progressPercent) - progress) >=
              PROGRESS_LOG_MIN_DELTA;

          if (shouldLog) {
            await cloudDb.insert(userBookProgressLog).values({
              id: crypto.randomUUID(),
              userId,
              bookId,
              progressPercent: progress,
              pageNumber: null,
              location,
              source: 'reader',
              occurredAt: new Date(),
              createdAt: new Date(),
            });
          }
        }
      } catch (logError) {
        logger.error(
          logError,
          'PUT /api/books/:id/reading-position: Error logging progress',
        );
      }
    }

    return { success: true, data: { location, progress } };
  } catch (error: unknown) {
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';

    if (message.toLowerCase().includes('unique')) {
      try {
        await cloudDb
          .update(userBookReadingPosition)
          .set({ location: location ?? '', progress, updatedAt: new Date() })
          .where(
            and(
              eq(userBookReadingPosition.userId, userId),
              eq(userBookReadingPosition.bookId, bookId),
            ),
          );

        return { success: true, data: { location, progress } };
      } catch (e) {
        logger.error(
          e,
          'PUT /api/books/:id/reading-position: Error after unique retry',
        );
      }
    }

    logger.error(
      error,
      'PUT /api/books/:id/reading-position: Error updating reading position',
    );
    setResponseStatus(event, 500);
    return { success: false, message: 'Failed to update reading position' };
  }
});
