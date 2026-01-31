import { and, eq, inArray } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  collectionBooks,
  collectionMembers,
  collections,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

/**
 * GET /api/books/:id/collections
 *
 * Returns the list of collections the given book belongs to, scoped to the
 * current user's visibility (must be a member of each returned collection).
 *
 * Also returns the user's membership role per collection (owner|editor|viewer).
 *
 * Guardrails:
 * - Uses 404 when the book is not visible to the user to avoid leaking existence.
 */
export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books/:id/collections');

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;

  const bookId = getRouterParam(event, 'id');
  if (!bookId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing book id' });
  }

  try {
    // Which collections is the user a member of?
    const memberships = await cloudDb
      .select({
        collectionId: collectionMembers.collectionId,
        role: collectionMembers.role,
      })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, userId));

    const memberCollectionIds = Array.from(
      new Set(memberships.map((m) => m.collectionId)),
    ).filter(Boolean);

    if (!memberCollectionIds.length) {
      // User can't see any collections => they can't see any books.
      throw createError({ statusCode: 404, statusMessage: 'Book not found' });
    }

    // Which of those member collections contain this book?
    const links = await cloudDb
      .select({
        collectionId: collectionBooks.collectionId,
      })
      .from(collectionBooks)
      .where(
        and(
          eq(collectionBooks.bookId, bookId),
          inArray(collectionBooks.collectionId, memberCollectionIds),
        ),
      );

    const visibleCollectionIds = Array.from(
      new Set(links.map((l) => l.collectionId)),
    ).filter(Boolean);

    if (!visibleCollectionIds.length) {
      // Not in any collection the user can access => treat as not found
      // to avoid leaking existence.
      throw createError({ statusCode: 404, statusMessage: 'Book not found' });
    }

    // Load collections (small N expected).
    const rows = await Promise.all(
      visibleCollectionIds.map(async (id) => {
        const res = await cloudDb
          .select({
            id: collections.id,
            name: collections.name,
            ownerUserId: collections.ownerUserId,
            isPersonal: collections.isPersonal,
          })
          .from(collections)
          .where(eq(collections.id, id))
          .limit(1);

        const c = res[0];
        if (!c) return null;

        const role =
          memberships.find((m) => m.collectionId === id)?.role ?? 'viewer';

        return { ...c, role };
      }),
    );

    const out = rows.filter((r): r is NonNullable<typeof r> => r !== null);

    return {
      success: true,
      data: {
        collections: out,
      },
    };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors (401/400/404) thrown above
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(error, 'GET /api/books/:id/collections: Error fetching data');
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch book collections',
    });
  }
});
