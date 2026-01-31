import { and, eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { bookRatings, books } from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * POST /api/books/:id/rating
 *
 * Sets (or clears) the authenticated user's rating for a book.
 *
 * Ratings are unique per (user, book).
 *
 * Body:
 * - { rating: number | null }
 *
 * Rating scale:
 * - stored as integer half-stars: 1..10 => 0.5..5.0 stars
 * - send `null` (or 0) to clear/delete the rating
 *
 * Response:
 * - { success: true, data: { rating: number | null } }
 */
export default defineEventHandler(async (event) => {
  logger.debug('POST /api/books/:id/rating');

  // Require auth
  const session = await auth.api.getSession({
    headers: event.headers,
  });

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

  // Parse body
  const body = (await readBody(event).catch(() => null)) as {
    rating?: unknown;
  } | null;

  const raw = body?.rating;

  // Allow clearing with null/undefined/0
  const wantsClear = raw === null || raw === undefined || raw === 0;

  let rating: number | null = null;

  if (!wantsClear) {
    const parsed =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number(raw)
          : NaN;

    if (!Number.isFinite(parsed)) {
      setResponseStatus(event, 400);
      return {
        success: false,
        message: 'Invalid rating (must be a number 1..10, or null to clear).',
      };
    }

    // We store integer half-stars (1..10).
    // If client sends 0.5 increments as stars (e.g. 3.5), convert to half-star int.
    // If client already sends 1..10, accept it.
    if (
      parsed > 0 &&
      parsed <= 5 &&
      Math.abs(parsed * 2 - Math.round(parsed * 2)) < 1e-9
    ) {
      rating = Math.round(parsed * 2);
    } else {
      rating = Math.round(parsed);
    }

    if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
      setResponseStatus(event, 400);
      return {
        success: false,
        message:
          'Invalid rating (must be 1..10 half-stars, or 0.5..5.0 stars).',
      };
    }
  }

  try {
    // Ensure book exists (don't leak extra info; just 404 if missing)
    const exists = await cloudDb
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    if (!exists[0]) {
      setResponseStatus(event, 404);
      return { success: false, message: 'Book not found' };
    }

    if (rating === null) {
      // Clear rating by deleting the row
      await cloudDb
        .delete(bookRatings)
        .where(
          and(eq(bookRatings.bookId, bookId), eq(bookRatings.userId, userId)),
        );

      return { success: true, data: { rating: null } };
    }

    // Upsert rating: try update first; if nothing updated, insert.
    const updatedAt = new Date();

    const updateRes = await cloudDb
      .update(bookRatings)
      .set({ rating, updatedAt })
      .where(
        and(eq(bookRatings.bookId, bookId), eq(bookRatings.userId, userId)),
      );

    // Drizzle update return shape can vary by driver; handle both numeric and object.
    const rowsAffected =
      typeof updateRes === 'number'
        ? updateRes
        : ((updateRes as { rowsAffected?: number })?.rowsAffected ?? 0);

    if (!rowsAffected) {
      await cloudDb.insert(bookRatings).values({
        userId,
        bookId,
        rating,
        updatedAt,
      });
    }

    return { success: true, data: { rating } };
  } catch (error: unknown) {
    // If the unique constraint triggers due to a race, fall back to update.
    // (We intentionally keep this narrow to avoid masking unrelated issues.)
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';

    if (message.toLowerCase().includes('unique')) {
      try {
        await cloudDb
          .update(bookRatings)
          .set({ rating: rating ?? 0, updatedAt: new Date() })
          .where(
            and(eq(bookRatings.bookId, bookId), eq(bookRatings.userId, userId)),
          );

        return { success: true, data: { rating } };
      } catch (e) {
        logger.error(e, 'POST /api/books/:id/rating: Error after unique retry');
      }
    }

    logger.error(error, 'POST /api/books/:id/rating: Error setting rating');
    setResponseStatus(event, 500);
    return { success: false, message: 'Failed to set rating' };
  }
});
