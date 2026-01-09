import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { setHardcoverToken } from '~~/server/utils/secrets/hardcover';

type Body = {
  /**
   * Raw Hardcover token. May be:
   * - "<token>"
   * - "Bearer <token>"
   *
   * Pass empty string to clear.
   */
  token?: unknown;
};

/**
 * PUT /api/settings/admin/hardcover-token
 *
 * Admin-only endpoint to set/clear the Hardcover bearer token server-side.
 *
 * Security:
 * - Requires authenticated session
 * - Requires role: admin | owner
 * - Stores token server-side only (never returned to the client)
 */
export default defineEventHandler(async (event) => {
  logger.debug('PUT /api/settings/admin/hardcover-token');

  const session = await auth.api.getSession({ headers: event.headers });

  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const user = session.user;
  if (user.role !== 'admin' && user.role !== 'owner') {
    setResponseStatus(event, 403);
    return { success: false, message: 'Forbidden' };
  }

  const body = await readBody<Body>(event);
  const tokenRaw = body?.token;

  if (typeof tokenRaw !== 'string') {
    setResponseStatus(event, 400);
    return {
      success: false,
      message: 'Missing or invalid `token` (string) in body',
    };
  }

  try {
    await setHardcoverToken(tokenRaw);

    return {
      success: true,
      data: {
        cleared: tokenRaw.trim().length === 0,
      },
    };
  } catch (error) {
    logger.error(
      { error },
      'PUT /api/settings/admin/hardcover-token: Error updating Hardcover token',
    );
    setResponseStatus(event, 500);
    return { success: false, message: 'Internal Server Error' };
  }
});
