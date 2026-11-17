import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  bookShelfDimensions,
  books,
  collectionMembers,
  personalShelfBooks,
  personalShelves,
} from '~/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { lockCollectionChanges } from '~~/server/utils/collections/model';
import { validatePictureAssets } from '~~/server/utils/bookshelf/pictures';
import {
  BOOKSHELF_MAX_BOOKS,
  estimatedWidth,
  parseBookshelf,
  type Bookshelf,
  type ShelfBook,
} from '~~/shared/bookshelf';
import {
  composeBookshelfLayout,
  emptyBookshelfGeometry,
  bookshelfGeometry,
  type BookPlacementAnchor,
} from '~~/shared/bookshelf-layout';

type Db = Parameters<Parameters<typeof cloudDb.transaction>[0]>[0];
const tokenSecret =
  process.env.BETTER_AUTH_SECRET || randomBytes(32).toString('hex');
const fail = (statusCode: number, statusMessage: string): never => {
  throw createError({ statusCode, statusMessage });
};

function parsePlacement(value: unknown): BookPlacementAnchor | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('caseId' in value) ||
    typeof value.caseId !== 'string' ||
    !('shelfId' in value) ||
    typeof value.shelfId !== 'string' ||
    !('stackId' in value) ||
    typeof value.stackId !== 'string' ||
    !('x' in value) ||
    typeof value.x !== 'number' ||
    !Number.isSafeInteger(value.x) ||
    !('horizontal' in value) ||
    typeof value.horizontal !== 'boolean' ||
    !('order' in value) ||
    typeof value.order !== 'number' ||
    !Number.isSafeInteger(value.order)
  )
    return null;
  return {
    caseId: value.caseId,
    shelfId: value.shelfId,
    stackId: value.stackId,
    x: value.x,
    ...('bookX' in value &&
    typeof value.bookX === 'number' &&
    Number.isSafeInteger(value.bookX)
      ? { bookX: value.bookX }
      : {}),
    horizontal: value.horizontal,
    order: value.order,
    ...('width' in value && typeof value.width === 'number'
      ? { width: value.width }
      : {}),
    ...('height' in value && typeof value.height === 'number'
      ? { height: value.height }
      : {}),
    ...('dormant' in value && typeof value.dormant === 'boolean'
      ? { dormant: value.dormant }
      : {}),
  };
}
async function owned(db: Db, userId: string, shelfId: string) {
  const [shelf] = await db
    .select()
    .from(personalShelves)
    .where(
      and(eq(personalShelves.id, shelfId), eq(personalShelves.ownerId, userId)),
    )
    .limit(1);
  if (!shelf) return fail(404, 'Shelf not found');
  return shelf;
}
async function visible(db: Db, userId: string, shelfId: string) {
  return db
    .select({
      id: books.id,
      title: books.title,
      pages: books.pages,
      collectionId: books.collectionId,
      spineRevision: sql<
        string | null
      >`(select revision from book_spines indexed by book_spines_book_revision_idx where book_id=${books.id})`,
      authorNames: sql<string>`coalesce((select json_group_array(name) from (select a.name as name from book_authors ba join authors a on a.id=ba.author_id where ba.book_id=${books.id} order by coalesce(ba.position,10000), a.id)), '[]')`,
      dimensions: {
        width: bookShelfDimensions.width,
        height: bookShelfDimensions.height,
        manualWidth: bookShelfDimensions.manualWidth,
        manualHeight: bookShelfDimensions.manualHeight,
        sourcePages: bookShelfDimensions.sourcePages,
      },
      placement: personalShelfBooks.placement,
      role: collectionMembers.role,
    })
    .from(personalShelfBooks)
    .innerJoin(books, eq(books.id, personalShelfBooks.bookId))
    .innerJoin(
      collectionMembers,
      and(
        eq(collectionMembers.collectionId, books.collectionId),
        eq(collectionMembers.userId, userId),
      ),
    )
    .leftJoin(bookShelfDimensions, eq(bookShelfDimensions.bookId, books.id))
    .where(eq(personalShelfBooks.shelfId, shelfId))
    .orderBy(asc(personalShelfBooks.addedAt), asc(personalShelfBooks.bookId))
    .limit(BOOKSHELF_MAX_BOOKS + 1);
}
function dimensions(
  row: Awaited<ReturnType<typeof visible>>[number],
): ShelfBook {
  if (row.dimensions) return { id: row.id, ...row.dimensions };
  let hash = 0;
  for (const c of row.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const pages =
    Number.isInteger(row.pages) &&
    row.pages !== null &&
    row.pages >= 0 &&
    row.pages <= 1000000
      ? row.pages
      : null;
  return {
    id: row.id,
    width: estimatedWidth(pages),
    height: 180 + (hash % 41),
    manualWidth: false,
    manualHeight: false,
    sourcePages: pages,
  };
}
function snapshotToken(
  shelfId: string,
  rows: Awaited<ReturnType<typeof visible>>,
) {
  return createHmac('sha256', tokenSecret)
    .update(
      JSON.stringify([
        shelfId,
        rows.map((r) => [r.id, r.collectionId, r.role, r.pages, r.dimensions]),
      ]),
    )
    .digest('hex');
}
async function snapshot(db: Db, userId: string, shelfId: string) {
  const shelf = await owned(db, userId, shelfId);
  const rows = await visible(db, userId, shelfId);
  if (rows.length > BOOKSHELF_MAX_BOOKS)
    return fail(400, 'This Shelf has too many books.');
  const geometry = composeBookshelfLayout(
    shelf.geometry,
    rows.map((row) => ({
      book: dimensions(row),
      placement: parsePlacement(row.placement),
    })),
    shelf.id,
  );
  return {
    id: shelf.id,
    name: shelf.name,
    revision: shelf.revision,
    token: snapshotToken(shelfId, rows),
    ...geometry,
    canEdit: true,
    books: rows.map(
      ({ dimensions: _d, placement: _p, role, authorNames, ...row }) => ({
        ...row,
        authorNames: JSON.parse(authorNames),
        canResize: role === 'owner' || role === 'editor',
      }),
    ),
  };
}

async function persistVisiblePlacements(
  db: Db,
  shelfId: string,
  layout: Bookshelf,
  rows: Awaited<ReturnType<typeof visible>>,
) {
  const previous = new Map(
    rows.map((row) => [row.id, parsePlacement(row.placement)]),
  );
  const values: Array<{
    shelfId: string;
    bookId: string;
    placement: BookPlacementAnchor;
    addedAt: Date;
  }> = [];
  for (const bookcase of layout.bookcases)
    for (const row of bookcase.shelves)
      for (const item of row.items) {
        const anchors = item.books.map((book) => previous.get(book.id));
        const first = anchors[0];
        const preserveStack =
          !!first &&
          anchors.every(
            (p, index) =>
              !!p &&
              p.stackId === first.stackId &&
              p.caseId === bookcase.id &&
              p.shelfId === row.id &&
              (p.bookX ?? p.x) === item.x + (item.books[index]!.offsetX ?? 0) &&
              p.horizontal === item.horizontal &&
              (index === 0 || p.order > (anchors[index - 1]?.order ?? -1)),
          );
        const stackId = preserveStack ? first!.stackId : randomUUID();
        item.books.forEach((book, order) =>
          values.push({
            shelfId,
            bookId: book.id,
            addedAt: new Date(),
            placement: {
              caseId: bookcase.id,
              shelfId: row.id,
              stackId,
              x: item.x,
              bookX: item.x + (book.offsetX ?? 0),
              horizontal: item.horizontal,
              order: preserveStack ? anchors[order]!.order : order,
              width: book.width,
              height: book.height,
              dormant: false,
            },
          }),
        );
      }
  for (let i = 0; i < values.length; i += 100)
    await db
      .insert(personalShelfBooks)
      .values(values.slice(i, i + 100))
      .onConflictDoUpdate({
        target: [personalShelfBooks.shelfId, personalShelfBooks.bookId],
        set: { placement: sql`excluded.placement` },
      });
  const visibleIds = new Set(rows.map((row) => row.id));
  const all = await db
    .select({
      bookId: personalShelfBooks.bookId,
      placement: personalShelfBooks.placement,
    })
    .from(personalShelfBooks)
    .where(eq(personalShelfBooks.shelfId, shelfId));
  for (const member of all) {
    if (visibleIds.has(member.bookId)) continue;
    const placement = parsePlacement(member.placement);
    if (placement && !placement.dormant)
      await db
        .update(personalShelfBooks)
        .set({ placement: { ...placement, dormant: true } })
        .where(
          and(
            eq(personalShelfBooks.shelfId, shelfId),
            eq(personalShelfBooks.bookId, member.bookId),
          ),
        );
  }
}
export async function readShelf(userId: string, shelfId: string) {
  return cloudDb.transaction((tx) => snapshot(tx, userId, shelfId));
}
export async function listShelves(userId: string) {
  return cloudDb.transaction(async (tx) => {
    const shelves = await tx
      .select()
      .from(personalShelves)
      .where(eq(personalShelves.ownerId, userId))
      .orderBy(asc(personalShelves.createdAt), asc(personalShelves.id));
    return Promise.all(
      shelves.map(async (shelf) => {
        const rows = await visible(tx, userId, shelf.id);
        return {
          id: shelf.id,
          name: shelf.name,
          count: rows.length,
          previews: rows.slice(0, 4).map(({ id, title }) => ({ id, title })),
        };
      }),
    );
  });
}
export async function createShelf(userId: string, name: string) {
  const clean = name.trim();
  if (!clean || clean.length > 120)
    return fail(400, 'Enter a Shelf name of up to 120 characters.');
  const id = randomUUID();
  await cloudDb.insert(personalShelves).values({
    id,
    ownerId: userId,
    name: clean,
    revision: 0,
    geometry: bookshelfGeometry(emptyBookshelfGeometry()),
    createdAt: new Date(),
  });
  return { id, name: clean };
}
export async function renameShelf(
  userId: string,
  shelfId: string,
  name: string,
) {
  const clean = name.trim();
  if (!clean || clean.length > 120)
    return fail(400, 'Enter a Shelf name of up to 120 characters.');
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    const shelf = await owned(tx, userId, shelfId);
    await tx
      .update(personalShelves)
      .set({ name: clean, revision: shelf.revision + 1 })
      .where(eq(personalShelves.id, shelfId));
  });
}
export async function deleteShelf(userId: string, shelfId: string) {
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    await owned(tx, userId, shelfId);
    await tx
      .delete(personalShelfBooks)
      .where(eq(personalShelfBooks.shelfId, shelfId));
    await tx.delete(personalShelves).where(eq(personalShelves.id, shelfId));
  });
}
export async function changeShelfBooks(
  userId: string,
  shelfId: string,
  ids: string[],
  action: 'add' | 'remove',
) {
  const unique = [...new Set(ids)];
  if (
    !unique.length ||
    unique.length > BOOKSHELF_MAX_BOOKS ||
    unique.some((id) => !id || id.length > 128)
  )
    return fail(400, 'Choose valid books.');
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    const shelf = await owned(tx, userId, shelfId);
    const authorized = new Set<string>();
    for (let i = 0; i < unique.length; i += 400) {
      const rows = await tx
        .select({ id: books.id })
        .from(books)
        .innerJoin(
          collectionMembers,
          and(
            eq(collectionMembers.collectionId, books.collectionId),
            eq(collectionMembers.userId, userId),
          ),
        )
        .where(inArray(books.id, unique.slice(i, i + 400)));
      rows.forEach((row) => authorized.add(row.id));
    }
    if (authorized.size !== unique.length)
      return fail(404, 'One or more books are unavailable.');
    if (action === 'add') {
      const existing = await tx
        .select({ count: sql<number>`count(*)` })
        .from(personalShelfBooks)
        .where(eq(personalShelfBooks.shelfId, shelfId));
      const previous = await tx
        .select({ id: personalShelfBooks.bookId })
        .from(personalShelfBooks)
        .where(eq(personalShelfBooks.shelfId, shelfId));
      const set = new Set(previous.map((r) => r.id));
      const additions = unique.filter((id) => !set.has(id));
      if (
        Number(existing[0]?.count ?? 0) + additions.length >
        BOOKSHELF_MAX_BOOKS
      )
        return fail(400, 'This Shelf has too many books.');
      for (let i = 0; i < additions.length; i += 100)
        await tx
          .insert(personalShelfBooks)
          .values(
            additions.slice(i, i + 100).map((bookId) => ({
              shelfId,
              bookId,
              placement: null,
              addedAt: new Date(),
            })),
          )
          .onConflictDoNothing();
    } else {
      for (let i = 0; i < unique.length; i += 400)
        await tx
          .delete(personalShelfBooks)
          .where(
            and(
              eq(personalShelfBooks.shelfId, shelfId),
              inArray(personalShelfBooks.bookId, unique.slice(i, i + 400)),
            ),
          );
    }
    const composed = await snapshot(tx, userId, shelfId);
    await persistVisiblePlacements(
      tx,
      shelfId,
      composed.arrangement,
      await visible(tx, userId, shelfId),
    );
    await tx
      .update(personalShelves)
      .set({
        geometry: bookshelfGeometry(composed.arrangement),
        revision: shelf.revision + 1,
      })
      .where(eq(personalShelves.id, shelfId));
    return snapshot(tx, userId, shelfId);
  });
}
export async function saveShelf(
  userId: string,
  shelfId: string,
  revision: number,
  token: string,
  raw: unknown,
) {
  const layout = parseBookshelf(raw);
  if (!layout) return fail(400, 'Invalid Shelf arrangement.');
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    const shelf = await owned(tx, userId, shelfId);
    const rows = await visible(tx, userId, shelfId);
    if (revision !== shelf.revision || token !== snapshotToken(shelfId, rows))
      return fail(409, 'This Shelf or its books changed. Reload to continue.');
    if (
      shelf.geometry &&
      typeof shelf.geometry === 'object' &&
      'version' in shelf.geometry &&
      shelf.geometry.version === 2 &&
      (!raw ||
        typeof raw !== 'object' ||
        !('version' in raw) ||
        raw.version !== 2)
    )
      return fail(
        409,
        'This Shelf needs a newer version of Delb. Reload before saving.',
      );
    await validatePictureAssets(tx, { kind: 'personal', id: shelfId }, layout);
    const placed = layout.bookcases.flatMap((c) =>
      c.shelves.flatMap((s) => s.items.flatMap((i) => i.books)),
    );
    const map = new Map(rows.map((row) => [row.id, row]));
    if (
      placed.length !== rows.length ||
      placed.some((book) => !map.has(book.id))
    )
      return fail(409, 'This Shelf or its books changed. Reload to continue.');
    const updates = placed.filter((book) => {
      const row = map.get(book.id)!;
      const old = dimensions(row);
      return (
        book.width !== old.width ||
        book.height !== old.height ||
        book.manualWidth !== old.manualWidth ||
        book.manualHeight !== old.manualHeight ||
        book.sourcePages !== old.sourcePages
      );
    });
    for (const book of updates) {
      const row = map.get(book.id)!;
      if (row.role !== 'owner' && row.role !== 'editor')
        return fail(403, 'You cannot resize this book.');
      if (book.sourcePages !== dimensions(row).sourcePages)
        return fail(
          409,
          'This Shelf or its books changed. Reload to continue.',
        );
    }
    for (let i = 0; i < updates.length; i += 100)
      await tx
        .insert(bookShelfDimensions)
        .values(
          updates.slice(i, i + 100).map((book) => ({
            bookId: book.id,
            width: book.width,
            height: book.height,
            manualWidth: book.manualWidth,
            manualHeight: book.manualHeight,
            sourcePages: book.sourcePages,
          })),
        )
        .onConflictDoUpdate({
          target: bookShelfDimensions.bookId,
          set: {
            width: sql`excluded.width`,
            height: sql`excluded.height`,
            manualWidth: sql`excluded.manual_width`,
            manualHeight: sql`excluded.manual_height`,
            sourcePages: sql`excluded.source_pages`,
          },
        });
    await persistVisiblePlacements(tx, shelfId, layout, rows);
    await tx
      .update(personalShelves)
      .set({
        geometry: bookshelfGeometry(layout),
        revision: shelf.revision + 1,
      })
      .where(eq(personalShelves.id, shelfId));
    const updated = await snapshot(tx, userId, shelfId);
    return { revision: updated.revision, token: updated.token };
  });
}
