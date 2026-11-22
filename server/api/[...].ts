/**
 * Catch-all handler for unmatched `/api/*` routes.
 *
 * In SPA mode (`ssr: false`), Nitro otherwise falls back to serving the client
 * HTML shell for unknown routes. Returning a proper 404 error keeps API
 * semantics intact and matches the upcoming Go router behavior.
 */
export default defineEventHandler(() => {
  throw createError({
    statusCode: 404,
    statusMessage: 'Not Found',
  });
});
