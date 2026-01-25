import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';
import { deleteBook, type DeleteMode } from '~~/server/utils/books/delete-book';

function normalizeDeleteMode(raw: string | null | undefined): DeleteMode {
  const v = (raw ?? '').toString().trim();
  if (v === 'db_only' || v === 'everything') return v;
  return 'everything';
}

/**
 * DELETE /api/books/:id
 *
 * Admin-only endpoint that deletes the book. Supports only 2 modes:
 *
 * Query params:
 * - mode=
 *   - db_only:     DB rows only (no disk changes).
 *   - everything:  DB rows + delete the book folder under `library/` (default).
 */
export default defineEventHandler(async (event) => {
  logger.debug('DELETE /api/books/:id');

  // Ensure the user is authenticated and is an admin/owner
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (
    !session ||
    (session.user.role !== 'admin' && session.user.role !== 'owner')
  ) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const id = getRouterParam(event, 'id');
  if (!id) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Missing book id' };
  }

  const mode = normalizeDeleteMode(getQuery(event)?.mode?.toString());

  try {
    const logCtx = `DELETE /api/books/:id (${mode})`;
    await deleteBook({
      bookId: id,
      mode,
      actor: { id: session.user.id, role: session.user.role },
      logCtx,
    });

    return { success: true, data: { mode } };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(error, 'DELETE /api/books/:id: Error deleting book');
    setResponseStatus(event, 500);
    return { success: false, message: 'Internal server error' };
  }
});
