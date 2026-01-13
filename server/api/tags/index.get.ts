import { and, asc, countDistinct, eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  bookTags,
  books,
  collectionBooks,
  collectionMembers,
  tags,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/tags?collectionId=<optional>
 *
 * Returns all tags the current user can access, with per-tag book counts.
 *
 * Access control:
 * - Requires an authenticated user
 * - Only returns tags that have at least one book in collections the user is a member of
 * - If `collectionId` is provided, results are scoped to that one collection (must be a member)
 *
 * Response shape:
 * {
 *   success: true,
 *   data: {
 *     tags: Array<{ id: string; name: string; bookCount: number }>
 *   }
 * }
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/tags');

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const { collectionId } = getQuery(event) as { collectionId?: string };

  // If a collectionId is provided, verify membership to avoid leaking metadata.
  if (collectionId) {
    const membership = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(
        and(
          eq(collectionMembers.collectionId, collectionId),
          eq(collectionMembers.userId, session.user.id),
        ),
      )
      .limit(1);

    if (!membership[0]) {
      setResponseStatus(event, 403);
      return { success: false, message: 'Forbidden' };
    }
  }

  try {
    /**
     * We want:
     * - tags visible via books in collections the user can access
     * - optional scope to one collection
     * - count distinct books per tag
     *
     * Joins:
     * tags <- bookTags -> books -> collectionBooks -> collectionMembers
     */
    const rows = await cloudDb
      .select({
        id: tags.id,
        name: tags.name,
        bookCount: countDistinct(books.id),
      })
      .from(tags)
      .innerJoin(bookTags, eq(bookTags.tagId, tags.id))
      .innerJoin(books, eq(books.id, bookTags.bookId))
      .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
      .innerJoin(
        collectionMembers,
        eq(collectionMembers.collectionId, collectionBooks.collectionId),
      )
      .where(
        and(
          eq(collectionMembers.userId, session.user.id),
          collectionId
            ? eq(collectionBooks.collectionId, collectionId)
            : // No additional filter when not scoped to one collection.
              // Keep a single `and(...)` shape with a tautology.
              eq(collectionMembers.userId, session.user.id),
        ),
      )
      .groupBy(tags.id, tags.name)
      .orderBy(asc(tags.name));

    const out = rows.map((r) => ({
      id: r.id,
      name: r.name,
      // SQLite returns integers for COUNT; coerce defensively
      bookCount: typeof r.bookCount === 'number' ? r.bookCount : Number(r.bookCount),
    }));

    return {
      success: true,
      data: {
        tags: out,
      },
    };
  } catch (error: unknown) {
    logger.error(error, 'GET /api/tags: failed');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to load tags',
    });
  }
});
