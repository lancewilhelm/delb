import { and, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookPreferences,
} from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

type Body = {
  enabled?: unknown;
};

function parseBoolean(raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === '1') return true;
    if (v === '0') return false;
  }
  return null;
}

/**
 * PUT /api/books/:id/progress-sync
 *
 * Updates per-book progress sync toggle for the authenticated user.
 */
export default defineEventHandler(async (event) => {
  logger.debug('PUT /api/books/:id/progress-sync');

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

  const body = (await readBody<Body>(event).catch(() => null)) ?? {};
  const enabled = parseBoolean(body.enabled);
  if (enabled === null) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Invalid enabled value.' };
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

    const updatedAt = new Date();

    const updateRes = await cloudDb
      .update(userBookPreferences)
      .set({ progressSyncEnabled: enabled, updatedAt })
      .where(
        and(
          eq(userBookPreferences.userId, userId),
          eq(userBookPreferences.bookId, bookId),
        ),
      );

    const rowsAffected =
      typeof updateRes === 'number'
        ? updateRes
        : ((updateRes as { rowsAffected?: number })?.rowsAffected ?? 0);

    if (!rowsAffected) {
      try {
        await cloudDb.insert(userBookPreferences).values({
          userId,
          bookId,
          progressSyncEnabled: enabled,
          updatedAt,
        });
      } catch (e: unknown) {
        const msg =
          typeof e === 'object' && e !== null && 'message' in e
            ? String((e as { message?: unknown }).message ?? '')
            : '';
        if (msg.toLowerCase().includes('unique')) {
          await cloudDb
            .update(userBookPreferences)
            .set({ progressSyncEnabled: enabled, updatedAt: new Date() })
            .where(
              and(
                eq(userBookPreferences.userId, userId),
                eq(userBookPreferences.bookId, bookId),
              ),
            );
        } else {
          throw e;
        }
      }
    }

    return { success: true, data: { progressSyncEnabled: enabled } };
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
      'PUT /api/books/:id/progress-sync: Error updating preference',
    );
    setResponseStatus(event, 500);
    return { success: false, message: 'Failed to update progress sync' };
  }
});
