import { and, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  bookFiles,
  books,
  collectionBooks,
  collectionMembers,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/books/:id/files
 *
 * Lightweight endpoint for listing downloadable files for a book.
 * Intended for quick UI affordances (e.g. cover context menu).
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books/:id/files');

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;

  const id = getRouterParam(event, 'id');
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  }

  // Enforce visibility: user must be a member of at least one collection
  // that contains the requested book.
  const memberships = await cloudDb
    .select({ collectionId: collectionMembers.collectionId })
    .from(collectionMembers)
    .where(eq(collectionMembers.userId, userId));

  const memberCollectionIds = Array.from(
    new Set(memberships.map((m) => m.collectionId)),
  ).filter(Boolean);

  if (!memberCollectionIds.length) {
    throw createError({ statusCode: 404, statusMessage: 'Book not found' });
  }

  const visible = await cloudDb
    .select({ id: books.id })
    .from(books)
    .innerJoin(
      collectionBooks,
      and(eq(collectionBooks.bookId, books.id), eq(books.id, id)),
    )
    .where(inArray(collectionBooks.collectionId, memberCollectionIds))
    .limit(1);

  if (!visible[0]?.id) {
    throw createError({ statusCode: 404, statusMessage: 'Book not found' });
  }

  const files = await cloudDb
    .select()
    .from(bookFiles)
    .where(eq(bookFiles.bookId, id));

  return { success: true, data: { files } };
});
