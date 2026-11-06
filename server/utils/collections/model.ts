import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  books,
  collectionMembers,
  collections,
  systemState,
  users,
} from '../../../app/utils/db/schema';
import type { cloudDb } from '../db/cloud';

export type CollectionDatabase = typeof cloudDb;
export type CollectionConnection = Pick<
  CollectionDatabase,
  'select' | 'insert' | 'update' | 'delete' | 'run' | 'get' | 'all'
>;

export class CollectionError extends Error {
  statusMessage: string;
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.statusMessage = message;
  }
}

export async function collectionModelState(db: CollectionConnection) {
  const rows = await db
    .select()
    .from(systemState)
    .where(eq(systemState.key, 'collections-model'));
  return rows[0]?.value ?? 'pending';
}

export async function requireCollectionModel(db: CollectionConnection) {
  if ((await collectionModelState(db)) !== 'exclusive') {
    throw new CollectionError(
      503,
      'Collection migration required. An administrator must preview and apply it in Settings > Admin > Collections.',
    );
  }
}

export async function lockCollectionChanges(db: CollectionConnection) {
  await db.run(
    sql`UPDATE system_state SET value=value WHERE key='collections-model'`,
  );
}

export async function assertCollectionEditor(
  db: CollectionConnection,
  userId: string,
  collectionId: string,
) {
  const rows = await db
    .select({ role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.userId, userId),
        eq(collectionMembers.collectionId, collectionId),
      ),
    );
  if (rows[0]?.role !== 'owner' && rows[0]?.role !== 'editor') {
    throw new CollectionError(
      403,
      'Owner or editor access to the collection is required',
    );
  }
}

export async function assertBookEditor(
  db: CollectionConnection,
  userId: string,
  bookId: string,
) {
  const rows = await db
    .select({ collectionId: books.collectionId })
    .from(books)
    .innerJoin(
      collectionMembers,
      and(
        eq(collectionMembers.collectionId, books.collectionId),
        eq(collectionMembers.userId, userId),
      ),
    )
    .where(eq(books.id, bookId));
  if (!rows[0]) throw new CollectionError(404, 'Book not found');
  await assertCollectionEditor(db, userId, rows[0].collectionId);
  return rows[0].collectionId;
}

export async function assertCollectionAdmin(
  db: CollectionConnection,
  userId: string,
) {
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  if (rows[0]?.role !== 'admin' && rows[0]?.role !== 'owner')
    throw new CollectionError(403, 'Administrator access required');
}

export async function assertAccountDeletionAllowed(
  db: CollectionConnection,
  userId: string,
) {
  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  if (user?.role === 'owner')
    throw new CollectionError(403, 'The system owner cannot be removed');
  const owned = await db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.ownerUserId, userId))
    .limit(1);
  if (owned.length)
    throw new CollectionError(
      409,
      'Transfer or delete owned collections before deleting this account',
    );
}

export async function assertCollectionManager(
  db: CollectionConnection,
  userId: string,
  collectionId: string,
  ownerOnly = false,
) {
  const [collection] = await db
    .select()
    .from(collections)
    .where(eq(collections.id, collectionId));
  if (!collection) throw new CollectionError(404, 'Collection not found');
  const [actor] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  if (actor?.role === 'admin' || actor?.role === 'owner') return collection;
  if (ownerOnly) {
    if (collection.ownerUserId !== userId)
      throw new CollectionError(403, 'Collection owner access required');
  } else await assertCollectionEditor(db, userId, collectionId);
  return collection;
}

export async function resolveBookTarget(
  db: CollectionConnection,
  userId: string,
  input?: unknown,
): Promise<string> {
  await requireCollectionModel(db);
  if (
    input !== undefined &&
    (!Array.isArray(input) ||
      input.some((id: unknown) => typeof id !== 'string' || !id.trim()))
  ) {
    throw new CollectionError(400, 'Choose exactly one collection');
  }
  const ids =
    input === undefined
      ? []
      : Array.from(new Set(input.map((id: string) => id.trim())));
  if (ids.length > 1)
    throw new CollectionError(400, 'A book belongs to exactly one collection');
  let id = ids[0];
  if (!id) {
    const rows = await db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.isDefault, true));
    id = rows[0]?.id;
  }
  if (!id)
    throw new CollectionError(
      409,
      'No default collection is configured. Choose a collection.',
    );
  await assertCollectionEditor(db, userId, id);
  return id;
}

export async function enrollUserInDefault(
  db: CollectionConnection,
  userId: string,
) {
  await lockCollectionChanges(db);
  await requireCollectionModel(db);
  let [target] = await db
    .select()
    .from(collections)
    .where(eq(collections.isDefault, true));
  if (!target) {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'owner'));
    if (!owner)
      throw new CollectionError(
        409,
        'The system owner must be initialized first',
      );
    [target] = await db
      .insert(collections)
      .values({
        id: crypto.randomUUID(),
        name: 'Default',
        ownerUserId: owner.id,
        isPersonal: false,
        isDefault: true,
      })
      .returning();
  }
  if (!target)
    throw new CollectionError(409, 'Default collection initialization failed');
  await db
    .insert(collectionMembers)
    .values({
      collectionId: target.id,
      userId,
      role: target.ownerUserId === userId ? 'owner' : 'editor',
    })
    .onConflictDoNothing();
}

export async function enrollNewUser(db: CollectionDatabase, userId: string) {
  await db.transaction((tx) => enrollUserInDefault(tx, userId));
}

export async function changeDefaultCollection(
  db: CollectionDatabase,
  userId: string,
  collectionId: string,
) {
  return db.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    await assertCollectionAdmin(tx, userId);
    await requireCollectionModel(tx);
    const [target] = await tx
      .select()
      .from(collections)
      .where(eq(collections.id, collectionId));
    if (!target) throw new CollectionError(404, 'Collection not found');
    await tx
      .update(collections)
      .set({ isDefault: false })
      .where(eq(collections.isDefault, true));
    await tx
      .update(collections)
      .set({ isDefault: true })
      .where(eq(collections.id, collectionId));
  });
}

export async function moveCollectionBooks(
  db: CollectionDatabase,
  userId: string,
  bookIds: string[],
  targetId: string,
  expectedSourceId?: string | Record<string, string>,
) {
  if (!bookIds.length) throw new CollectionError(400, 'Choose books to move');
  return db.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    await requireCollectionModel(tx);
    await assertCollectionEditor(tx, userId, targetId);
    const rows = await tx
      .select({ id: books.id, collectionId: books.collectionId })
      .from(books)
      .innerJoin(
        collectionMembers,
        and(
          eq(collectionMembers.collectionId, books.collectionId),
          eq(collectionMembers.userId, userId),
        ),
      )
      .where(inArray(books.id, [...new Set(bookIds)]));
    if (rows.length !== new Set(bookIds).size)
      throw new CollectionError(404, 'Book not found');
    if (
      expectedSourceId &&
      rows.some(
        (row) =>
          row.collectionId !==
          (typeof expectedSourceId === 'string'
            ? expectedSourceId
            : expectedSourceId[row.id]),
      )
    )
      throw new CollectionError(
        409,
        'The source collection changed. Review the move again.',
      );
    for (const sourceId of new Set(rows.map((row) => row.collectionId)))
      await assertCollectionEditor(tx, userId, sourceId);
    await tx
      .update(books)
      .set({
        collectionId: targetId,
        addedByUserId: userId,
        addedAt: new Date(),
      })
      .where(
        inArray(
          books.id,
          rows.map((row) => row.id),
        ),
      );
    return rows.length;
  });
}
