import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  bookShelfDimensions,
  books,
  collectionBookshelves,
  collectionMembers,
} from '~/utils/db/schema';
import {
  BOOKSHELF_MAX_BOOKS,
  emptyBookshelf,
  parseBookshelf,
  reconcileBookshelf,
} from '~~/shared/bookshelf';
import { cloudDb } from '~~/server/utils/db/cloud';
import { lockCollectionChanges } from '~~/server/utils/collections/model';
import { validatePictureAssets } from './pictures';
import {
  composeBookshelfLayout,
  bookshelfGeometry,
  type BookLayoutEntry,
} from '~~/shared/bookshelf-layout';

type Db = Parameters<Parameters<typeof cloudDb.transaction>[0]>[0];

async function readCatalog(db: Db, collectionId: string) {
  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      pages: books.pages,
      collectionId: books.collectionId,
      // The artwork row contains large images; read the revision from the covering index.
      spineRevision: sql<
        string | null
      >`(select revision from book_spines indexed by book_spines_book_revision_idx where book_id=${books.id})`,
      dimensions: {
        width: bookShelfDimensions.width,
        height: bookShelfDimensions.height,
        manualWidth: bookShelfDimensions.manualWidth,
        manualHeight: bookShelfDimensions.manualHeight,
        sourcePages: bookShelfDimensions.sourcePages,
      },
      authorNames: sql<string>`coalesce((select json_group_array(name) from (select a.name as name from book_authors ba join authors a on a.id=ba.author_id where ba.book_id=${books.id} order by coalesce(ba.position,10000), a.id)), '[]')`,
    })
    .from(books)
    .leftJoin(bookShelfDimensions, eq(bookShelfDimensions.bookId, books.id))
    .where(eq(books.collectionId, collectionId))
    .orderBy(asc(books.createdAt), asc(books.id))
    .limit(BOOKSHELF_MAX_BOOKS + 1);
  if (rows.length > BOOKSHELF_MAX_BOOKS)
    throw createError({
      statusCode: 400,
      statusMessage: 'This collection exceeds the supported bookshelf size.',
    });
  return rows.map((row) => ({
    ...row,
    authorNames: JSON.parse(row.authorNames) as string[],
  }));
}

function catalogToken(catalog: Awaited<ReturnType<typeof readCatalog>>) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        catalog.map(({ id, pages, dimensions }) => ({ id, pages, dimensions })),
      ),
    )
    .digest('hex');
}

async function memberRole(db: Db, userId: string, collectionId: string) {
  const [member] = await db
    .select({ role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.userId, userId),
        eq(collectionMembers.collectionId, collectionId),
      ),
    )
    .limit(1);
  if (!member)
    throw createError({
      statusCode: 404,
      statusMessage: 'Collection not found',
    });
  return member.role;
}

export async function readCollectionShelf(
  userId: string,
  collectionId: string,
) {
  return cloudDb.transaction(async (tx) => {
    const role = await memberRole(tx, userId, collectionId);
    const catalog = await readCatalog(tx, collectionId);
    const [stored] = await tx
      .select()
      .from(collectionBookshelves)
      .where(eq(collectionBookshelves.collectionId, collectionId))
      .limit(1);
    const layout = stored
      ? parseBookshelf(stored.arrangement)
      : emptyBookshelf();
    if (!layout)
      throw createError({
        statusCode: 500,
        statusMessage: 'The saved bookshelf could not be read.',
      });
    const dimensions = new Map(
      catalog.map((book) => [book.id, book.dimensions]),
    );
    const visible = new Set(catalog.map((book) => book.id));
    const placements: BookLayoutEntry[] = [];
    for (const bookcase of layout.bookcases)
      for (const shelf of bookcase.shelves)
        for (const [index, item] of shelf.items.entries())
          for (const [order, book] of item.books.entries()) {
            const oldWidth = book.width;
            const oldHeight = book.height;
            const storedDimensions = dimensions.get(book.id);
            if (storedDimensions) Object.assign(book, storedDimensions);
            if (visible.has(book.id))
              placements.push({
                book,
                placement: {
                  caseId: bookcase.id,
                  shelfId: shelf.id,
                  stackId: `${bookcase.id}/${shelf.id}/${index}`,
                  x: item.x,
                  bookX: item.x + (book.offsetX ?? 0),
                  horizontal: item.horizontal,
                  order,
                  width: oldWidth,
                  height: oldHeight,
                },
              });
          }
    const repaired = parseBookshelf(layout)
      ? null
      : composeBookshelfLayout(
          bookshelfGeometry(layout),
          placements,
          collectionId,
        );
    const reconciled = reconcileBookshelf(
      repaired?.arrangement ?? layout,
      catalog,
    );
    if (!parseBookshelf(reconciled.bookshelf))
      throw createError({
        statusCode: 400,
        statusMessage:
          'This collection exceeds the supported bookshelf arrangement size.',
      });
    return {
      revision: stored?.revision ?? 0,
      token: catalogToken(catalog),
      arrangement: reconciled.bookshelf,
      adjustments: [
        ...new Set([
          ...(repaired?.adjustments ?? []),
          ...reconciled.needsAdjustment,
        ]),
      ],
      books: catalog.map(({ dimensions: _dimensions, ...book }) => book),
      canEdit: role === 'owner' || role === 'editor',
    };
  });
}

export async function saveCollectionShelf(
  userId: string,
  collectionId: string,
  revision: number,
  token: string,
  rawArrangement: unknown,
) {
  const arrangement = parseBookshelf(rawArrangement);
  if (!arrangement)
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid bookshelf arrangement.',
    });
  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    const role = await memberRole(tx, userId, collectionId);
    if (role !== 'owner' && role !== 'editor')
      throw createError({
        statusCode: 403,
        statusMessage: 'Owner or editor access is required.',
      });
    const catalog = await readCatalog(tx, collectionId);
    const [stored] = await tx
      .select({
        revision: collectionBookshelves.revision,
        arrangement: collectionBookshelves.arrangement,
      })
      .from(collectionBookshelves)
      .where(eq(collectionBookshelves.collectionId, collectionId))
      .limit(1);
    if ((stored?.revision ?? 0) !== revision || catalogToken(catalog) !== token)
      throw createError({
        statusCode: 409,
        statusMessage:
          'This bookshelf or its books changed. Reload to review the latest version.',
      });
    if (
      stored?.arrangement &&
      typeof stored.arrangement === 'object' &&
      'version' in stored.arrangement &&
      stored.arrangement.version === 2 &&
      (!rawArrangement ||
        typeof rawArrangement !== 'object' ||
        !('version' in rawArrangement) ||
        rawArrangement.version !== 2)
    )
      throw createError({
        statusCode: 409,
        statusMessage:
          'This bookshelf needs a newer version of Delb. Reload before saving.',
      });
    await validatePictureAssets(
      tx,
      { kind: 'collection', id: collectionId },
      arrangement,
    );
    const placed = arrangement.bookcases.flatMap((bookcase) =>
      bookcase.shelves.flatMap((shelf) =>
        shelf.items.flatMap((item) => item.books),
      ),
    );
    const currentIds = new Set(catalog.map((book) => book.id));
    if (
      placed.length !== currentIds.size ||
      placed.some((book) => !currentIds.has(book.id))
    )
      throw createError({
        statusCode: 409,
        statusMessage:
          'The collection books changed. Reload to review the latest version.',
      });
    const currentDimensions = new Map(
      catalog.map((book) => [book.id, book.dimensions]),
    );
    const changedDimensions = placed.filter((book) => {
      const current = currentDimensions.get(book.id);
      return (
        !current ||
        current.width !== book.width ||
        current.height !== book.height ||
        current.manualWidth !== book.manualWidth ||
        current.manualHeight !== book.manualHeight ||
        current.sourcePages !== book.sourcePages
      );
    });
    for (let index = 0; index < changedDimensions.length; index += 100) {
      await tx
        .insert(bookShelfDimensions)
        .values(
          changedDimensions.slice(index, index + 100).map((book) => ({
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
    }
    const next = revision + 1;
    await tx
      .insert(collectionBookshelves)
      .values({ collectionId, revision: next, arrangement })
      .onConflictDoUpdate({
        target: collectionBookshelves.collectionId,
        set: { revision: next, arrangement },
      });
    const updated = await readCatalog(tx, collectionId);
    return { revision: next, token: catalogToken(updated) };
  });
}
