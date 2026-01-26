import { logger } from '~/utils/logger';

export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books/metadata/search');

  const query = getQuery(event);
  const searchQuery = query.q as string;

  if (!searchQuery || typeof searchQuery !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Search query parameter "q" is required',
    });
  }

  try {
    // Call Google Books API
    const response = await $fetch(
      `https://www.googleapis.com/books/v1/volumes`,
      {
        params: {
          q: searchQuery,
          maxResults: 20,
        },
      },
    );

    return response;
  } catch (error) {
    console.error('Google Books API error:', error);
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch metadata from Google Books',
    });
  }
});
