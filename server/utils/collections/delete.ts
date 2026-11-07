import path from 'node:path';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { eq, ne } from 'drizzle-orm';
import {
  bookFiles,
  books,
  collections,
  storageOperations,
} from '../../../app/utils/db/schema';
import { withBookStorageLock } from '../books/storage/book-lock';
import { deleteStoredFiles } from '../books/storage/delete-operation';
import {
  assertCollectionManager,
  CollectionError,
  lockCollectionChanges,
  requireCollectionModel,
  type CollectionConnection,
  type CollectionDatabase,
} from './model';

export async function deleteCollection(opts: {
  db: CollectionDatabase;
  libraryRoot: string;
  userId: string;
  collectionId: string;
  confirmationName: string;
}) {
  const { db, userId, collectionId, confirmationName } = opts;
  const root = path.resolve(opts.libraryRoot);
  const lockId = `collection-delete:${collectionId}`;

  async function authorize(connection: CollectionConnection) {
    await requireCollectionModel(connection);
    const collection = await assertCollectionManager(
      connection,
      userId,
      collectionId,
      true,
    );
    if (collection.isDefault)
      throw new CollectionError(
        409,
        'Choose a replacement default before deleting this collection',
      );
    if (confirmationName !== collection.name)
      throw new CollectionError(
        409,
        'The collection name changed. Review deletion and type its current name.',
      );
  }

  async function plan(connection: CollectionConnection) {
    const entries = await connection
      .select({ id: books.id, cover: books.coverImagePath })
      .from(books)
      .where(eq(books.collectionId, collectionId))
      .orderBy(books.id);
    const files = await connection
      .select({ id: bookFiles.id, path: bookFiles.relativePath })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .where(eq(books.collectionId, collectionId))
      .orderBy(bookFiles.id);
    // Outside references also protect thumbnails in a shared book directory.
    const otherFiles = await connection
      .select({ path: bookFiles.relativePath })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .where(ne(books.collectionId, collectionId));
    const otherCovers = await connection
      .select({ path: books.coverImagePath })
      .from(books)
      .where(ne(books.collectionId, collectionId));
    const outside = new Set(
      [...otherFiles, ...otherCovers].flatMap((row) =>
        row.path ? [row.path] : [],
      ),
    );
    const outsideDirs = new Set(
      [...outside].map((file) => path.posix.dirname(file)),
    );
    const paths = [
      ...new Set([
        ...files.map((file) => file.path),
        ...entries.flatMap((entry) => (entry.cover ? [entry.cover] : [])),
      ]),
    ]
      .filter((file) => !outside.has(file))
      .sort();
    const sidecarDirs = [
      ...new Set(paths.map((file) => path.posix.dirname(file))),
    ]
      .filter(
        (dir) => dir !== 'library' && dir !== '.' && !outsideDirs.has(dir),
      )
      .sort();
    return { entries, files, paths, sidecarDirs };
  }

  return withBookStorageLock(root, lockId, async () => {
    await authorize(db);
    const ids = (
      await db
        .select({ id: books.id })
        .from(books)
        .where(eq(books.collectionId, collectionId))
        .orderBy(books.id)
    ).map((row) => row.id);

    async function withLocks(index: number): Promise<{ deletedBooks: number }> {
      const id = ids[index];
      if (id !== undefined)
        return withBookStorageLock(root, id, () => withLocks(index + 1));

      await authorize(db);
      const before = await plan(db);
      if (
        JSON.stringify(before.entries.map((entry) => entry.id)) !==
        JSON.stringify(ids)
      )
        throw new CollectionError(
          409,
          'The collection contents changed. Review deletion again.',
        );

      await mkdir(root, { recursive: true });
      const realRoot = await realpath(root);
      function resolveStored(stored: string) {
        const file = path.resolve(
          root,
          stored.replace(/\\/g, '/').replace(/^library\//, ''),
        );
        const relative = path.relative(root, file);
        if (
          !relative ||
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          throw new CollectionError(
            409,
            'A book file is outside the managed library',
          );
        return file;
      }
      const candidates = new Set(before.paths.map(resolveStored));
      for (const directory of before.sidecarDirs) {
        const dir = resolveStored(directory);
        try {
          for (const entry of await readdir(dir, { withFileTypes: true }))
            if (entry.isFile() && /^(cover[.-]|thumb\.webp$)/i.test(entry.name))
              candidates.add(path.join(dir, entry.name));
        } catch (error) {
          if (!(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          ))
            throw error;
        }
      }
      const sources: string[] = [];
      for (const file of candidates) {
        try {
          const relative = path.relative(realRoot, await realpath(file));
          if (
            !relative ||
            relative === '..' ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            throw new CollectionError(
              409,
              'A book file is outside the managed library',
            );
          if (!(await stat(file)).isFile())
            throw new CollectionError(409, 'A book file is not a regular file');
          sources.push(file);
        } catch (error) {
          if (!(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          ))
            throw error;
        }
      }
      const decision = {
        isCommitted: async (id: string) =>
          (
            await db
              .select({ id: storageOperations.id })
              .from(storageOperations)
              .where(eq(storageOperations.id, id))
          ).length > 0,
        remove: async (id: string) => {
          await db
            .delete(storageOperations)
            .where(eq(storageOperations.id, id));
        },
      };
      await deleteStoredFiles({
        root,
        bookId: lockId,
        sources,
        decision,
        commit: async (operationId) =>
          db.transaction(async (tx) => {
            await lockCollectionChanges(tx);
            await authorize(tx);
            if (JSON.stringify(await plan(tx)) !== JSON.stringify(before))
              throw new CollectionError(
                409,
                'The collection contents changed. Review deletion again.',
              );
            await tx.insert(storageOperations).values({
              id: operationId,
              bookId: lockId,
              kind: 'delete',
              createdAt: new Date(),
            });
            // Reader data and book links cascade in the same transaction.
            await tx.delete(books).where(eq(books.collectionId, collectionId));
            await tx
              .delete(collections)
              .where(eq(collections.id, collectionId));
          }),
      });
      return { deletedBooks: ids.length };
    }
    return withLocks(0);
  });
}
