import { and, eq, inArray } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  collectionBooks,
  collectionMembers,
  collections,
} from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

type BulkBody = {
  /**
   * If true, applies to all books currently in this collection.
   * (Does not require the client to enumerate IDs.)
   */
  allInCollection?: unknown;

  /**
   * If allInCollection=true, any IDs listed here will be excluded from the operation.
   */
  excludedBookIds?: unknown;

  /**
   * If allInCollection=false, apply to these specific IDs.
   */
  bookIds?: unknown;

  /**
   * Add the selected books to these collections (where the caller is owner/editor).
   */
  addToCollectionIds?: unknown;

  /**
   * Remove the selected books from these collections (where the caller is owner/editor).
   * Guardrails: personal collections are non-removable.
   */
  removeFromCollectionIds?: unknown;
};

type Role = 'owner' | 'editor' | 'viewer';

function normalizeStringIdArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid id list',
    });
  }

  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid id list',
      });
    }
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }

  return Array.from(new Set(out));
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (value === null) return fallback;
  if (typeof value === 'boolean') return value;
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid boolean flag',
  });
}

function assertNoOverlap(a: string[], b: string[], msg: string) {
  const bSet = new Set(b);
  const overlap = a.filter((id) => bSet.has(id));
  if (overlap.length) {
    throw createError({
      statusCode: 400,
      statusMessage: msg,
    });
  }
}

export default defineEventHandler(async (event) => {
  logger.debug('POST /api/collections/:id/books/bulk');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;

  const collectionId = getRouterParam(event, 'id');
  if (!collectionId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing collection id',
    });
  }

  const body = (await readBody<BulkBody>(event)) ?? {};

  const allInCollection = normalizeBoolean(body.allInCollection, false);
  const excludedBookIds = normalizeStringIdArray(body.excludedBookIds);
  const bookIds = normalizeStringIdArray(body.bookIds);

  const addToCollectionIds = normalizeStringIdArray(body.addToCollectionIds);
  const removeFromCollectionIds = normalizeStringIdArray(
    body.removeFromCollectionIds,
  );

  if (!addToCollectionIds.length && !removeFromCollectionIds.length) {
    return {
      success: true,
      data: {
        scope: { collectionId, allInCollection },
        booksResolved: 0,
        added: [],
        removed: [],
        forbidden: [],
        ignoredPersonalRemovals: [],
      },
    };
  }

  assertNoOverlap(
    addToCollectionIds,
    removeFromCollectionIds,
    'Same collection id cannot be present in both addToCollectionIds and removeFromCollectionIds',
  );

  if (allInCollection) {
    if (bookIds.length) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Do not provide bookIds when allInCollection=true',
      });
    }
  } else {
    if (!bookIds.length) {
      throw createError({
        statusCode: 400,
        statusMessage:
          'Provide bookIds (or set allInCollection=true) to perform bulk actions',
      });
    }
    if (excludedBookIds.length) {
      throw createError({
        statusCode: 400,
        statusMessage:
          'Do not provide excludedBookIds when allInCollection=false',
      });
    }
  }

  // Load target collection to enforce guardrails (e.g. "All" is not addressable here; personal non-removable).
  const targetCollectionRow = await cloudDb
    .select({
      id: collections.id,
      isPersonal: collections.isPersonal,
    })
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1);

  const targetCollection = targetCollectionRow[0];
  if (!targetCollection) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Collection not found',
    });
  }

  // Must be owner/editor of the *scope collection* to apply bulk operations from this view.
  const scopeMembership = await cloudDb
    .select({
      role: collectionMembers.role,
    })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, collectionId),
        eq(collectionMembers.userId, userId),
      ),
    )
    .limit(1);

  const scopeRole = scopeMembership[0]?.role as Role | undefined;
  const canEditScope = scopeRole === 'owner' || scopeRole === 'editor';
  if (!canEditScope) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
    });
  }

  // Resolve the effective book IDs.
  let effectiveBookIds: string[] = [];

  if (allInCollection) {
    const rows = await cloudDb
      .select({ bookId: collectionBooks.bookId })
      .from(collectionBooks)
      .where(eq(collectionBooks.collectionId, collectionId));

    const excluded = new Set(excludedBookIds);
    effectiveBookIds = rows
      .map((r) => r.bookId)
      .filter((id) => id && !excluded.has(id));

    // If the user excluded everything, no-op.
    if (!effectiveBookIds.length) {
      return {
        success: true,
        data: {
          scope: { collectionId, allInCollection },
          booksResolved: 0,
          added: [],
          removed: [],
          forbidden: [],
          ignoredPersonalRemovals: [],
        },
      };
    }
  } else {
    effectiveBookIds = bookIds;
  }

  // RBAC gate for target collections (edit rights required for add/remove).
  const targetCollectionIds = Array.from(
    new Set([...addToCollectionIds, ...removeFromCollectionIds]),
  );

  const memberships = await cloudDb
    .select({
      collectionId: collectionMembers.collectionId,
      role: collectionMembers.role,
    })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.userId, userId),
        inArray(collectionMembers.collectionId, targetCollectionIds),
      ),
    );

  const roleByCollectionId = new Map(
    memberships.map((m) => [m.collectionId, m.role as Role] as const),
  );

  const canEditTarget = (id: string) => {
    const r = roleByCollectionId.get(id);
    return r === 'owner' || r === 'editor';
  };

  const forbidden: string[] = [];
  const eligibleAdd: string[] = [];
  const eligibleRemove: string[] = [];

  for (const id of addToCollectionIds) {
    if (!canEditTarget(id)) forbidden.push(id);
    else eligibleAdd.push(id);
  }

  for (const id of removeFromCollectionIds) {
    if (!canEditTarget(id)) forbidden.push(id);
    else eligibleRemove.push(id);
  }

  const uniqueForbidden = Array.from(new Set(forbidden));

  // Personal guardrail on removals (non-removable).
  const ignoredPersonalRemovals: string[] = [];
  let finalRemoveIds = eligibleRemove;

  if (eligibleRemove.length) {
    const personalRows = await cloudDb
      .select({
        id: collections.id,
        isPersonal: collections.isPersonal,
      })
      .from(collections)
      .where(inArray(collections.id, eligibleRemove));

    const personalSet = new Set(
      personalRows.filter((r) => r.isPersonal).map((r) => r.id),
    );

    if (personalSet.size) {
      ignoredPersonalRemovals.push(
        ...eligibleRemove.filter((id) => personalSet.has(id)),
      );
      finalRemoveIds = eligibleRemove.filter((id) => !personalSet.has(id));
    }
  }

  const now = new Date();

  const added: Array<{ collectionId: string; bookId: string }> = [];
  const removed: Array<{ collectionId: string; bookId: string }> = [];

  // Apply additions (idempotent per pair).
  for (const targetId of eligibleAdd) {
    for (const bookId of effectiveBookIds) {
      const existing = await cloudDb
        .select({ bookId: collectionBooks.bookId })
        .from(collectionBooks)
        .where(
          and(
            eq(collectionBooks.collectionId, targetId),
            eq(collectionBooks.bookId, bookId),
          ),
        )
        .limit(1);

      if (existing[0]) continue;

      await cloudDb.insert(collectionBooks).values({
        collectionId: targetId,
        bookId,
        addedByUserId: userId,
        addedAt: now,
      });

      added.push({ collectionId: targetId, bookId });
    }
  }

  // Apply removals (idempotent per pair).
  for (const targetId of finalRemoveIds) {
    for (const bookId of effectiveBookIds) {
      await cloudDb
        .delete(collectionBooks)
        .where(
          and(
            eq(collectionBooks.collectionId, targetId),
            eq(collectionBooks.bookId, bookId),
          ),
        );

      // Confirm absent, similar to single-book endpoint (best-effort).
      const stillThere = await cloudDb
        .select({ bookId: collectionBooks.bookId })
        .from(collectionBooks)
        .where(
          and(
            eq(collectionBooks.collectionId, targetId),
            eq(collectionBooks.bookId, bookId),
          ),
        )
        .limit(1);

      if (!stillThere[0]) {
        removed.push({ collectionId: targetId, bookId });
      } else {
        logger.warn(
          { bookId, collectionId: targetId },
          'bulk: expected row to be deleted but it still exists',
        );
      }
    }
  }

  return {
    success: true,
    data: {
      scope: { collectionId, allInCollection },
      booksResolved: effectiveBookIds.length,
      added,
      removed,
      forbidden: uniqueForbidden,
      ignoredPersonalRemovals: Array.from(new Set(ignoredPersonalRemovals)),
    },
  };
});
