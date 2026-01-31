import { and, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookStatus,
  USER_BOOK_STATUSES,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * POST /api/books/:id/status
 *
 * Sets (or clears) the authenticated user's status for a book.
 *
 * Status is mutually exclusive per (user, book).
 *
 * Body:
 * - { status: "to_be_read" | "reading" | "finished" | "dnf" | null }
 *
 * Clearing:
 * - send `null` (or omit `status`) to clear/delete the status
 *
 * Guardrails:
 * - Requires authenticated user
 * - Uses the same visibility model as GET /api/books/:id:
 *   the user must be a member of at least one collection that contains the book.
 *
 * Response:
 * - { success: true, data: { status: string | null } }
 */
export default defineEventHandler(async (event) => {
  logger.debug('POST /api/books/:id/status');

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
    status?: unknown;
  } | null;

  const raw = body?.status;

  // Clear if null/undefined/empty string
  const wantsClear = raw === null || raw === undefined || raw === '';

  // Validate status if not clearing.
  let status: (typeof USER_BOOK_STATUSES)[number] | null = null;

  if (!wantsClear) {
    if (typeof raw !== 'string') {
      setResponseStatus(event, 400);
      return {
        success: false,
        message: 'Invalid status (must be a string or null to clear).',
      };
    }

    // Keep it strict for now: only built-in statuses.
    if (!(USER_BOOK_STATUSES as readonly string[]).includes(raw)) {
      setResponseStatus(event, 400);
      return {
        success: false,
        message: `Invalid status. Expected one of: ${USER_BOOK_STATUSES.join(
          ', ',
        )}`,
      };
    }

    status = raw as (typeof USER_BOOK_STATUSES)[number];
  }

  try {
    // Enforce visibility:
    // user must be a member of at least one collection containing this book.
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

    if (status === null) {
      await cloudDb
        .delete(userBookStatus)
        .where(
          and(
            eq(userBookStatus.userId, userId),
            eq(userBookStatus.bookId, bookId),
          ),
        );

      return { success: true, data: { status: null } };
    }

    const updatedAt = new Date();

    // Upsert: try update first; if nothing updated, insert.
    const updateRes = await cloudDb
      .update(userBookStatus)
      .set({ status, updatedAt })
      .where(
        and(
          eq(userBookStatus.userId, userId),
          eq(userBookStatus.bookId, bookId),
        ),
      );

    const rowsAffected =
      typeof updateRes === 'number'
        ? updateRes
        : ((updateRes as { rowsAffected?: number })?.rowsAffected ?? 0);

    if (!rowsAffected) {
      await cloudDb.insert(userBookStatus).values({
        userId,
        bookId,
        status,
        updatedAt,
      });
    }

    return { success: true, data: { status } };
  } catch (error: unknown) {
    // If the unique constraint triggers due to a race, fall back to update.
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';

    if (message.toLowerCase().includes('unique')) {
      try {
        if (status === null) {
          await cloudDb
            .delete(userBookStatus)
            .where(
              and(
                eq(userBookStatus.userId, userId),
                eq(userBookStatus.bookId, bookId),
              ),
            );

          return { success: true, data: { status: null } };
        }

        await cloudDb
          .update(userBookStatus)
          .set({ status, updatedAt: new Date() })
          .where(
            and(
              eq(userBookStatus.userId, userId),
              eq(userBookStatus.bookId, bookId),
            ),
          );

        return { success: true, data: { status } };
      } catch (e) {
        logger.error(e, 'POST /api/books/:id/status: Error after unique retry');
      }
    }

    logger.error(error, 'POST /api/books/:id/status: Error setting status');
    setResponseStatus(event, 500);
    return { success: false, message: 'Failed to set status' };
  }
});
