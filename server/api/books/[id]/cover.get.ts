import {
  resolveBookCoverFile,
  shouldReturnNotModified,
  type CoverVariant,
} from '~~/server/utils/books/cover-delivery';

function normalizeVariant(raw: unknown): CoverVariant {
  const v = (raw ?? '').toString().trim().toLowerCase();
  if (!v || v === 'thumb') return 'thumb';
  if (v === 'source') return 'source';
  throw createError({ statusCode: 400, statusMessage: 'Invalid variant' });
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  }

  const variant = normalizeVariant(getQuery(event)?.variant);

  const resolved = await resolveBookCoverFile({
    event,
    bookId: id,
    variant,
  });

  setHeader(event, 'Content-Type', resolved.contentType);
  setHeader(event, 'Cache-Control', 'private, max-age=0, must-revalidate');
  setHeader(event, 'ETag', resolved.etag);
  setHeader(event, 'Vary', 'Cookie');

  if (
    shouldReturnNotModified({
      requestHeaders: event.headers,
      etag: resolved.etag,
    })
  ) {
    setResponseStatus(event, 304);
    return null;
  }

  return resolved.bytes;
});
