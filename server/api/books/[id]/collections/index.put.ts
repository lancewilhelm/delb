import { and, eq, inArray } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  collectionBooks,
  collectionMembers,
  collections,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

type PutBookCollectionsBody = {
  addCollectionIds?: unknown;
  removeCollectionIds?: unknown;
};

function normalizeStringIdArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid collection id list',
    });
  }

  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid collection id list',
      });
    }
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }

  // unique, stable order
  return Array.from(new Set(out));
}

function assertNoOverlap(addIds: string[], removeIds: string[]) {
  const removeSet = new Set(removeIds);
  const overlap = addIds.filter((id) => removeSet.has(id));
  if (overlap.length) {
    throw createError({
      statusCode: 400,
      statusMessage:
        'Same collection id cannot be present in both addCollectionIds and removeCollectionIds',
    });
  }
}

export default defineEventHandler(async (event) => {
  logger.debug('PUT /api/books/:id/collections');

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

  const body = (await readBody<PutBookCollectionsBody>(event)) ?? {};

  const addCollectionIds = normalizeStringIdArray(body.addCollectionIds);
  const removeCollectionIds = normalizeStringIdArray(body.removeCollectionIds);

  if (!addCollectionIds.length && !removeCollectionIds.length) {
    return {
      success: true,
      data: {
        added: [],
        removed: [],
        forbidden: [],
        ignoredPersonalRemovals: [],
      },
    };
  }

  assertNoOverlap(addCollectionIds, removeCollectionIds);

  // Enforce "Personal is mandatory": user cannot remove from ANY personal collection.
  // Even if it's not theirs, we treat it as non-removable guardrail.
  const targetIds = Array.from(
    new Set([...addCollectionIds, ...removeCollectionIds]),
  );

  // Load user's membership roles for target collections (RBAC gate: editor/owner for mutations).
  const memberships = await cloudDb
    .select({
      collectionId: collectionMembers.collectionId,
      role: collectionMembers.role,
    })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.userId, userId),
        inArray(collectionMembers.collectionId, targetIds),
      ),
    );

  const roleByCollectionId = new Map(
    memberships.map((m) => [m.collectionId, m.role] as const),
  );

  const canEdit = (collectionId: string) => {
    const role = roleByCollectionId.get(collectionId);
    return role === 'owner' || role === 'editor';
  };

  const forbidden: string[] = [];
  const eligibleAdd: string[] = [];
  const eligibleRemove: string[] = [];

  for (const id of addCollectionIds) {
    if (!canEdit(id)) forbidden.push(id);
    else eligibleAdd.push(id);
  }

  // For removals, we also need Personal guardrails; we’ll evaluate after loading collection.isPersonal.
  for (const id of removeCollectionIds) {
    if (!canEdit(id)) forbidden.push(id);
    else eligibleRemove.push(id);
  }

  const uniqueForbidden = Array.from(new Set(forbidden));

  // Determine which eligible removes are blocked due to Personal.
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

  // We do NOT currently assert book visibility here explicitly.
  // Guardrails:
  // - If the user can edit a collection, they can necessarily “see” it (they're a member).
  // - Adding/removing a book requires the book to already exist; FK constraints handle invalid ids.
  //
  // If you later want stronger anti-leak behavior, we can:
  // - check the book is visible to the user via any membership before doing anything,
  // - and treat non-visible as 404.

  const now = new Date();

  const added: string[] = [];
  const removed: string[] = [];

  // ADD: idempotent insert into collection_books (skip if already exists)
  for (const collectionId of eligibleAdd) {
    const existing = await cloudDb
      .select({
        collectionId: collectionBooks.collectionId,
      })
      .from(collectionBooks)
      .where(
        and(
          eq(collectionBooks.collectionId, collectionId),
          eq(collectionBooks.bookId, bookId),
        ),
      )
      .limit(1);

    if (existing[0]) continue;

    await cloudDb.insert(collectionBooks).values({
      collectionId,
      bookId,
      addedByUserId: userId,
      addedAt: now,
    });

    added.push(collectionId);
  }

  // REMOVE: idempotent delete from collection_books
  for (const collectionId of finalRemoveIds) {
    const res = await cloudDb
      .delete(collectionBooks)
      .where(
        and(
          eq(collectionBooks.collectionId, collectionId),
          eq(collectionBooks.bookId, bookId),
        ),
      );

    // Drizzle's delete result typing varies by driver; be conservative:
    // treat as "removed" if we attempted the delete and the pair is now absent.
    const stillThere = await cloudDb
      .select({ collectionId: collectionBooks.collectionId })
      .from(collectionBooks)
      .where(
        and(
          eq(collectionBooks.collectionId, collectionId),
          eq(collectionBooks.bookId, bookId),
        ),
      )
      .limit(1);

    if (!stillThere[0]) {
      removed.push(collectionId);
    } else {
      // If it remains, something is off (race or constraint). Don’t hard-fail;
      // return partial success and log for investigation.
      logger.warn(
        { bookId, collectionId, deleteResult: res },
        'PUT /api/books/:id/collections: expected row to be deleted but it still exists',
      );
    }
  }

  return {
    success: true,
    data: {
      added,
      removed,
      forbidden: uniqueForbidden,
      ignoredPersonalRemovals: Array.from(new Set(ignoredPersonalRemovals)),
    },
  };
});
