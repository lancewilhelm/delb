import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { fetchExternalImageBuffer } from '~~/server/utils/books/external-image';

/**
 * GET /api/books/metadata/cover?url=<encoded>
 *
 * Proxies an external cover image through the server to avoid browser CORS issues.
 *
 * Security:
 * - Requires authenticated session
 * - Allows only http/https URLs
 * - Enforces strict outbound network guards (blocks private/loopback/link-local/multicast)
 * - Limits redirects/timeout/max payload size
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books/metadata/cover');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const q = getQuery(event);
  const urlRaw = q.url;

  if (typeof urlRaw !== 'string' || !urlRaw.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Missing "url"' });
  }

  const fetched = await fetchExternalImageBuffer(urlRaw.trim());

  setHeader(event, 'Content-Type', fetched.contentType);
  setHeader(event, 'Cache-Control', 'private, no-store');
  setResponseHeader(event, 'Content-Length', fetched.bytes.length);

  return fetched.bytes;
});
