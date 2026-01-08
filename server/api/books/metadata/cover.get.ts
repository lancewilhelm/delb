import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/books/metadata/cover?url=<encoded>
 *
 * Proxies an external cover image through the server to avoid browser CORS issues.
 *
 * Security:
 * - Requires authenticated session (same as other book endpoints)
 * - Allows only http/https URLs
 *
 * Notes:
 * - This endpoint streams bytes back to the client with the upstream content-type.
 * - It intentionally does NOT cache.
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

  let url: URL;
  try {
    url = new URL(urlRaw);
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid url' });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid url protocol',
    });
  }

  // Keep headers minimal; some providers vary response based on UA/accept.
  // We also follow redirects (Google Books cover URLs commonly redirect http->https).
  const upstream = await fetch(url.toString(), {
    redirect: 'follow',
    headers: {
      Accept: 'image/*,*/*;q=0.8',
      'User-Agent': 'delb/metadata-cover-proxy',
    },
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    throw createError({
      statusCode: 502,
      statusMessage:
        text?.trim() ||
        `Upstream cover fetch failed (${upstream.status} ${upstream.statusText})`,
    });
  }

  const contentType =
    upstream.headers.get('content-type') || 'application/octet-stream';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw createError({
      statusCode: 502,
      statusMessage: 'Upstream did not return an image',
    });
  }

  // Read as arrayBuffer and return Buffer so Nitro sends binary correctly.
  const ab = await upstream.arrayBuffer();
  const buf = Buffer.from(ab);

  setHeader(event, 'Content-Type', contentType);
  setHeader(event, 'Cache-Control', 'no-store');
  // Best-effort: return length if known
  setResponseHeader(event, 'Content-Length', buf.length);

  return buf;
});
