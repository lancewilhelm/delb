import { USER_BOOK_STATUSES } from '~/utils/db/schema';
import { transitionBookStatuses } from '~~/server/utils/books/status-transition';
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
    const result = await transitionBookStatuses({
      userId,
      bookIds,
      change: { status },
      now: new Date(),
    });
    return {
      success: true,
      data: {
        requested: bookIds.length,
        visible: result.visible,
        updated: result.updated,
        cleared: result.cleared,
        ignoredNotVisible: bookIds.length - result.visible,
        status,
      },
    };
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error)
      throw error;
    logger.error(
      error,
      'POST /api/books/bulk/status: Error applying bulk status',
    );
    setResponseStatus(event, 500);
    return { success: false, message: 'Failed to apply bulk status' };
  }
});
