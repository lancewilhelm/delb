import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookProgressLog,
  userBookStatus,
  USER_BOOK_STATUSES,
} from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

type Body = {
  /**
   * Apply to these explicit book ids.
   *
   * NOTE:
   * - v1 does NOT support "all in scope" bulk semantics here.
   * - Client must enumerate ids.
   */
  bookIds?: unknown;

  /**
   * Status to apply:
   * - one of built-in USER_BOOK_STATUSES
   * - null to clear/unset
   */
  status?: unknown;
};

function normalizeStringIdArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid bookIds list',
    });
  }

  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid bookIds list',
      });
    }
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }

  return Array.from(new Set(out));
}

function normalizeStatus(
  value: unknown,
): (typeof USER_BOOK_STATUSES)[number] | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid status (must be a string or null)',
    });
  }

  if (!(USER_BOOK_STATUSES as readonly string[]).includes(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid status. Expected one of: ${USER_BOOK_STATUSES.join(', ')}`,
    });
  }

  return value as (typeof USER_BOOK_STATUSES)[number];
}

/**
 * POST /api/books/bulk/status
 *
 * Sets (or clears) the authenticated user's status for multiple books.
 *
 * IMPORTANT semantics:
 * - Status is mutually exclusive per (user, book).
 * - This will overwrite any existing status for those books.
 *
 * Body:
 * - { bookIds: string[], status: "to_be_read"|"reading"|"finished"|"dnf"|null }
 *
 * Access control / visibility:
 * - Requires auth
 * - Only applies to books that are "visible" to the user via collection membership
 *   (same visibility model as GET /api/books/:id).
 *
 * Response:
 * - { success: true, data: { requested: number, visible: number, updated: number, cleared: number, ignoredNotVisible: number, status: string|null } }
 */
export default defineEventHandler(async (event) => {
  logger.debug('POST /api/books/bulk/status');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const userId = session.user.id;

  const body = (await readBody<Body>(event).catch(() => ({}) as Body)) ?? {};
  const bookIds = normalizeStringIdArray(body.bookIds);
  const status = normalizeStatus(body.status);

  if (!bookIds.length) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Pick at least one book.' };
  }

  try {
    // Determine which collections the user can see
    const memberships = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, userId));

    const memberCollectionIds = Array.from(
      new Set(memberships.map((m) => m.collectionId)),
    ).filter(Boolean);

    if (!memberCollectionIds.length) {
      // User cannot see any collections => cannot see any books.
      return {
        success: true,
        data: {
          requested: bookIds.length,
          visible: 0,
          updated: 0,
          cleared: 0,
          ignoredNotVisible: bookIds.length,
          status,
        },
      };
    }

    // Compute visible book ids among the requested set:
    // books <- collectionBooks (for requested ids) and collectionBooks.collectionId in memberships
    const rows = await cloudDb
      .select({ bookId: books.id })
      .from(books)
      .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
      .where(
        and(
          inArray(books.id, bookIds),
          inArray(collectionBooks.collectionId, memberCollectionIds),
        ),
      );

    const visibleBookIds = Array.from(
      new Set(rows.map((r) => r.bookId)),
    ).filter(Boolean);

    const ignoredNotVisible = bookIds.length - visibleBookIds.length;

    if (!visibleBookIds.length) {
      return {
        success: true,
        data: {
          requested: bookIds.length,
          visible: 0,
          updated: 0,
          cleared: 0,
          ignoredNotVisible,
          status,
        },
      };
    }

    const updatedAt = new Date();
    const now = new Date();

    if (status === null) {
      // Clear/unset for all visible ids by deleting rows.
      const delRes = await cloudDb
        .delete(userBookStatus)
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
          ),
        );

      const cleared =
        typeof delRes === 'number'
          ? delRes
          : ((delRes as { rowsAffected?: number })?.rowsAffected ?? 0);

      return {
        success: true,
        data: {
          requested: bookIds.length,
          visible: visibleBookIds.length,
          updated: 0,
          cleared,
          ignoredNotVisible,
          status: null,
        },
      };
    }

    // Set status for all visible ids:
    // - Try update all rows in one statement
    // - Insert missing rows (no multi-row upsert used here to keep driver variance low)
    const updRes = await cloudDb
      .update(userBookStatus)
      .set({ status, updatedAt })
      .where(
        and(
          eq(userBookStatus.userId, userId),
          inArray(userBookStatus.bookId, visibleBookIds),
        ),
      );

    void updRes;

    // Find which visible ids already had a row (after update) vs missing.
    const existingRows = await cloudDb
      .select({ bookId: userBookStatus.bookId })
      .from(userBookStatus)
      .where(
        and(
          eq(userBookStatus.userId, userId),
          inArray(userBookStatus.bookId, visibleBookIds),
        ),
      );

    const existingSet = new Set(existingRows.map((r) => r.bookId));
    const missingIds = visibleBookIds.filter((id) => !existingSet.has(id));

    // Insert missing
    // NOTE: If a race causes unique constraint errors, we fall back to per-id update.
    if (missingIds.length) {
      const dateDefaults =
        status === 'reading'
          ? { startedAt: now }
          : status === 'finished'
            ? { startedAt: now, finishedAt: now }
            : status === 'dnf'
              ? { startedAt: now, dnfAt: now }
              : {};

      try {
        await cloudDb.insert(userBookStatus).values(
          missingIds.map((bookId) => ({
            userId,
            bookId,
            status,
            updatedAt,
            ...dateDefaults,
          })),
        );
      } catch (e: unknown) {
        const msg =
          typeof e === 'object' && e !== null && 'message' in e
            ? String((e as { message?: unknown }).message ?? '')
            : '';
        if (msg.toLowerCase().includes('unique')) {
          await Promise.allSettled(
            missingIds.map((bookId) =>
              cloudDb
                .update(userBookStatus)
                .set({ status, updatedAt: new Date() })
                .where(
                  and(
                    eq(userBookStatus.userId, userId),
                    eq(userBookStatus.bookId, bookId),
                  ),
                ),
            ),
          );
        } else {
          throw e;
        }
      }
    }

    if (status === 'reading') {
      await cloudDb
        .update(userBookStatus)
        .set({ startedAt: now })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
            eq(userBookStatus.status, 'reading'),
            isNull(userBookStatus.startedAt),
          ),
        );

      await cloudDb
        .update(userBookStatus)
        .set({ finishedAt: null, dnfAt: null })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
            eq(userBookStatus.status, 'reading'),
          ),
        );
    }

    if (status === 'finished') {
      await cloudDb
        .update(userBookStatus)
        .set({ finishedAt: now })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
            eq(userBookStatus.status, 'finished'),
            isNull(userBookStatus.finishedAt),
          ),
        );

      await cloudDb
        .update(userBookStatus)
        .set({ startedAt: sql`${userBookStatus.finishedAt}` })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
            eq(userBookStatus.status, 'finished'),
            isNull(userBookStatus.startedAt),
          ),
        );

      await cloudDb
        .update(userBookStatus)
        .set({ dnfAt: null })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
            eq(userBookStatus.status, 'finished'),
          ),
        );

      try {
        const existingLogs = await cloudDb
          .select({ bookId: userBookProgressLog.bookId })
          .from(userBookProgressLog)
          .where(
            and(
              eq(userBookProgressLog.userId, userId),
              inArray(userBookProgressLog.bookId, visibleBookIds),
              eq(userBookProgressLog.source, 'status-finished'),
            ),
          );

        const existingSet = new Set(existingLogs.map((row) => row.bookId));
        const booksWithPages = await cloudDb
          .select({ id: books.id, pages: books.pages })
          .from(books)
          .where(inArray(books.id, visibleBookIds));

        const logsToInsert = booksWithPages
          .filter((b) => !existingSet.has(b.id))
          .map((b) => ({
            id: crypto.randomUUID(),
            userId,
            bookId: b.id,
            progressPercent: 100,
            pageNumber: b.pages ?? null,
            location: null,
            source: 'status-finished',
            occurredAt: now,
            createdAt: now,
          }));

        if (logsToInsert.length) {
          await cloudDb.insert(userBookProgressLog).values(logsToInsert);
        }
      } catch (logError) {
        logger.error(
          logError,
          'POST /api/books/bulk/status: Error logging finished progress',
        );
      }
    }

    if (status === 'dnf') {
      await cloudDb
        .update(userBookStatus)
        .set({ dnfAt: now })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
            eq(userBookStatus.status, 'dnf'),
            isNull(userBookStatus.dnfAt),
          ),
        );

      await cloudDb
        .update(userBookStatus)
        .set({ startedAt: sql`${userBookStatus.dnfAt}` })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
            eq(userBookStatus.status, 'dnf'),
            isNull(userBookStatus.startedAt),
          ),
        );

      await cloudDb
        .update(userBookStatus)
        .set({ finishedAt: null })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
            eq(userBookStatus.status, 'dnf'),
          ),
        );
    }

    if (status === 'to_be_read') {
      await cloudDb
        .update(userBookStatus)
        .set({ startedAt: null, finishedAt: null, dnfAt: null })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            inArray(userBookStatus.bookId, visibleBookIds),
            eq(userBookStatus.status, 'to_be_read'),
          ),
        );
    }

    return {
      success: true,
      data: {
        requested: bookIds.length,
        visible: visibleBookIds.length,
        updated: visibleBookIds.length, // final state should be set for all visible ids
        cleared: 0,
        ignoredNotVisible,
        status,
      },
    };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors thrown by validation helpers
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
      'POST /api/books/bulk/status: Error applying bulk status',
    );
    setResponseStatus(event, 500);
    return { success: false, message: 'Failed to apply bulk status' };
  }
});
