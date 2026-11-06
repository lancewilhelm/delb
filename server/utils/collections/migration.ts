import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { systemState } from '../../../app/utils/db/schema';
import { withBookStorageLock } from '../books/storage/book-lock';
import {
  copyVerifiedExclusive,
  sameFileContents,
} from '../books/storage/verified-copy';
import {
  CollectionError,
  collectionModelState,
  lockCollectionChanges,
  type CollectionConnection,
  type CollectionDatabase,
} from './model';

type Row = Record<string, string | number | null>;
const catalogTables = [
  'users',
  'collections',
  'collection_members',
  'books',
  'legacy_collection_books',
  'book_authors',
  'book_tags',
  'book_identifiers',
  'book_files',
  'user_book_status',
  'user_book_reading_position',
  'user_book_preferences',
  'user_book_progress_log',
  'book_ratings',
  'user_book_rationale',
  'book_notes',
  'global_settings',
] as const;
type CatalogTable = (typeof catalogTables)[number];
const readerTables = [
  'user_book_status',
  'user_book_reading_position',
  'user_book_preferences',
  'user_book_progress_log',
  'book_ratings',
  'user_book_rationale',
  'book_notes',
] as const;

async function snapshot(db: CollectionConnection) {
  const data: Record<CatalogTable, Row[]> = {
    users: [],
    collections: [],
    collection_members: [],
    books: [],
    legacy_collection_books: [],
    book_authors: [],
    book_tags: [],
    book_identifiers: [],
    book_files: [],
    user_book_status: [],
    user_book_reading_position: [],
    user_book_preferences: [],
    user_book_progress_log: [],
    book_ratings: [],
    user_book_rationale: [],
    book_notes: [],
    global_settings: [],
  };
  for (const table of catalogTables)
    data[table] = await db.all<Row>(
      sql.raw(`SELECT * FROM "${table}" ORDER BY rowid`),
    );
  return {
    data,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex'),
  };
}

function copyId(bookId: string, collectionId: string) {
  const hash = createHash('sha256')
    .update(`${bookId}\0${collectionId}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export type MigrationChoice = { bookId: string; collectionId: string };
type MigrationPlan = {
  fingerprint: string;
  choices: MigrationChoice[];
  defaultId: string;
  recoveredId: string;
  ownerId: string;
  dropboxTargetId: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function legacyDropbox(data: Record<CatalogTable, Row[]>) {
  const row = data.global_settings[0];
  if (!row) return null;
  const settings: unknown = JSON.parse(String(row.settings));
  if (!record(settings) || !record(settings.dropbox)) return null;
  const dropbox = settings.dropbox;
  const ids = Array.from(
    new Set(
      [
        dropbox.targetCollectionId,
        ...(Array.isArray(dropbox.additionalCollectionIds)
          ? dropbox.additionalCollectionIds
          : []),
      ]
        .filter(
          (id): id is string => typeof id === 'string' && Boolean(id.trim()),
        )
        .map((id) => id.trim()),
    ),
  );
  return { row, settings, dropbox, ids };
}

function planValue(value: unknown): MigrationPlan {
  if (
    !value ||
    typeof value !== 'object' ||
    !('fingerprint' in value) ||
    typeof value.fingerprint !== 'string' ||
    !('choices' in value) ||
    !Array.isArray(value.choices) ||
    !('defaultId' in value) ||
    typeof value.defaultId !== 'string' ||
    !('recoveredId' in value) ||
    typeof value.recoveredId !== 'string' ||
    !('ownerId' in value) ||
    typeof value.ownerId !== 'string' ||
    !('dropboxTargetId' in value) ||
    (value.dropboxTargetId !== null &&
      typeof value.dropboxTargetId !== 'string')
  )
    throw new CollectionError(409, 'Invalid retained migration plan');
  const choices: MigrationChoice[] = value.choices.map((choice: unknown) => {
    if (
      !choice ||
      typeof choice !== 'object' ||
      !('bookId' in choice) ||
      typeof choice.bookId !== 'string' ||
      !('collectionId' in choice) ||
      typeof choice.collectionId !== 'string'
    )
      throw new CollectionError(400, 'Invalid migration choice');
    return { bookId: choice.bookId, collectionId: choice.collectionId };
  });
  return {
    fingerprint: value.fingerprint,
    choices,
    defaultId: value.defaultId,
    recoveredId: value.recoveredId,
    ownerId: value.ownerId,
    dropboxTargetId: value.dropboxTargetId,
  };
}

export async function previewCollectionMigration(db: CollectionDatabase) {
  const state = await collectionModelState(db);
  if (state === 'exclusive')
    return {
      state,
      fingerprint: '',
      users: 0,
      privateCollections: 0,
      recoveredBooks: 0,
      splits: [],
      retainedChoices: [],
      blockers: [],
      dropboxTargets: { needsChoice: false, options: [], configuredIds: [] },
      retainedDropboxTargetId: null,
    };
  const { data, fingerprint } = await snapshot(db);
  const [journal] = await db
    .select()
    .from(systemState)
    .where(eq(systemState.key, 'collection-migration-plan'));
  const retained = journal ? planValue(JSON.parse(journal.value)) : null;
  const splits = data.books.flatMap((book) => {
    const ids = data.legacy_collection_books
      .filter((link) => link.book_id === book.id)
      .map((link) => String(link.collection_id));
    return ids.length > 1
      ? [
          {
            bookId: String(book.id),
            title: String(book.title),
            calibreBookId: book.calibre_book_id,
            collections: ids.map((id) => ({
              id,
              name: String(
                data.collections.find((collection) => collection.id === id)
                  ?.name ?? id,
              ),
            })),
          },
        ]
      : [];
  });
  const operations = await db.all<Row>(sql`SELECT id FROM storage_operations`);
  const dropbox = legacyDropbox(data);
  const badOwners = data.collections.filter(
    (collection) =>
      data.collection_members.filter(
        (member) =>
          member.collection_id === collection.id && member.role === 'owner',
      ).length !== 1 ||
      !data.collection_members.some(
        (member) =>
          member.collection_id === collection.id &&
          member.user_id === collection.owner_user_id &&
          member.role === 'owner',
      ),
  );
  return {
    state,
    fingerprint,
    users: data.users.length,
    privateCollections: data.collections.filter(
      (collection) => collection.is_personal === 1,
    ).length,
    recoveredBooks: data.books.filter(
      (book) =>
        !data.legacy_collection_books.some((link) => link.book_id === book.id),
    ).length,
    splits,
    retainedChoices: retained?.choices ?? [],
    dropboxTargets: {
      needsChoice: Boolean(
        dropbox &&
        (dropbox.ids.length > 1 ||
          dropbox.ids.some(
            (id) =>
              !data.collections.some((collection) => collection.id === id),
          )),
      ),
      options: data.collections.map((collection) => ({
        id: String(collection.id),
        name: String(collection.name),
      })),
      configuredIds: dropbox?.ids ?? [],
    },
    retainedDropboxTargetId: retained ? (retained.dropboxTargetId ?? '') : null,
    blockers: [
      ...(!data.users.some((user) => user.role === 'owner')
        ? ['A system owner is required.']
        : []),
      ...(operations.length
        ? ['Complete pending managed-file recovery before migration.']
        : []),
      ...(badOwners.length
        ? ['Repair inconsistent legacy collection owners before migration.']
        : []),
    ],
  };
}

async function insertRow(
  db: CollectionConnection,
  table: CatalogTable,
  row: Row,
) {
  const entries = Object.entries(row);
  await db.run(
    sql`INSERT INTO ${sql.identifier(table)} (${sql.join(
      entries.map(([name]) => sql.identifier(name)),
      sql`, `,
    )}) VALUES (${sql.join(
      entries.map(([, value]) => sql`${value}`),
      sql`, `,
    )})`,
  );
}

async function inside(root: string, stored: string) {
  if (!stored.startsWith('library/') || stored.split(/[\\/]/).includes('..'))
    throw new CollectionError(409, `Invalid managed path: ${stored}`);
  const file = path.resolve(root, stored.slice('library/'.length));
  const actual = await realpath(file);
  if (!actual.startsWith(root + path.sep) || !(await lstat(file)).isFile())
    throw new CollectionError(409, `Unsafe managed file: ${stored}`);
  return actual;
}

async function copyBookFiles(
  root: string,
  book: Row,
  files: Row[],
  newId: string,
  fingerprint: string,
) {
  const known = [
    ...files.map((file) => String(file.relative_path)),
    ...(book.cover_image_path ? [String(book.cover_image_path)] : []),
  ];
  if (!known.length) return { files: new Map<string, string>(), cover: null };
  // A full ID prevents collisions between independent entries, including equal titles.
  const relativeDir = `collection-copies/${newId}`;
  const parent = path.join(root, 'collection-copies');
  await mkdir(parent, { recursive: true });
  if (
    (await lstat(parent)).isSymbolicLink() ||
    (await realpath(parent)) !== parent
  )
    throw new CollectionError(409, 'Unsafe collection copy directory');
  const directory = path.join(parent, newId);
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink())
    throw new CollectionError(409, 'Unsafe collection copy directory');
  const marker = path.join(directory, '.collection-migration.json');
  const identity = JSON.stringify({ fingerprint, newId });
  try {
    if ((await readFile(marker, 'utf8')) !== identity)
      throw new CollectionError(
        409,
        'Collection copy directory belongs to another migration',
      );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    if ((await readdir(directory)).length)
      throw new CollectionError(
        409,
        'Collection copy directory already contains files',
      );
    await writeFile(marker, identity, { flag: 'wx', flush: true });
  }
  const mapping = new Map<string, string>();
  const destinations = new Map<string, string>();
  const references = await Promise.all(
    known.map(async (stored) => ({
      stored,
      source: await inside(root, stored),
    })),
  );
  const primary =
    references.find(
      (reference) => reference.stored === book.cover_image_path,
    ) ?? references[0];
  if (!primary) return { files: mapping, cover: null };
  const primaryDir = path.dirname(primary.source);
  for (const { stored, source } of references) {
    const sourceDir = path.dirname(source);
    const prefix =
      sourceDir === primaryDir
        ? ''
        : createHash('sha256').update(sourceDir).digest('hex').slice(0, 12) +
          '-';
    const referencedNames = new Set(
      references
        .filter((reference) => path.dirname(reference.source) === sourceDir)
        .map((reference) => path.basename(reference.source)),
    );
    // Copy cover thumbnails and other regular book sidecars as well as referenced files.
    for (const entry of await readdir(path.dirname(source), {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      if (
        !referencedNames.has(entry.name) &&
        !(
          book.cover_image_path &&
          sourceDir === primaryDir &&
          /^(cover[.-]|thumb\.webp$)/i.test(entry.name)
        )
      )
        continue;
      const sourcePath = path.join(path.dirname(source), entry.name);
      const destination = path.join(directory, prefix + entry.name);
      const previous = destinations.get(destination);
      if (
        previous &&
        previous !== sourcePath &&
        !(await sameFileContents(previous, sourcePath))
      )
        throw new CollectionError(
          409,
          'Book file names collide during migration',
        );
      destinations.set(destination, sourcePath);
      try {
        if (!(await sameFileContents(sourcePath, destination)))
          await rm(destination);
        else continue;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error;
      }
      await copyVerifiedExclusive(sourcePath, destination);
    }
    mapping.set(
      stored,
      `library/${relativeDir}/${prefix}${path.basename(source)}`,
    );
  }
  return {
    files: mapping,
    cover: book.cover_image_path
      ? (mapping.get(String(book.cover_image_path)) ?? null)
      : null,
  };
}

export async function applyCollectionMigration(
  db: CollectionDatabase,
  libraryRoot: string,
  input: {
    fingerprint: string;
    choices: MigrationChoice[];
    backupConfirmed: boolean;
    dropboxTargetId?: string;
  },
) {
  if (input.backupConfirmed !== true)
    throw new CollectionError(
      400,
      'Confirm a matching database and library backup before migration',
    );
  await mkdir(libraryRoot, { recursive: true });
  const root = await realpath(libraryRoot);
  return withBookStorageLock(root, 'collection-model-migration', async () => {
    if ((await collectionModelState(db)) === 'exclusive')
      return { complete: true };
    const preview = await previewCollectionMigration(db);
    if (preview.blockers.length)
      throw new CollectionError(409, preview.blockers.join(' '));
    if (preview.fingerprint !== input.fingerprint)
      throw new CollectionError(
        409,
        'Library changed. Preview the migration again.',
      );
    if (
      input.choices.length !== preview.splits.length ||
      new Set(input.choices.map((choice) => choice.bookId)).size !==
        input.choices.length ||
      preview.splits.some(
        (split) =>
          !input.choices.some(
            (choice) =>
              choice.bookId === split.bookId &&
              split.collections.some(
                (collection) => collection.id === choice.collectionId,
              ),
          ),
      )
    )
      throw new CollectionError(
        400,
        'Choose which collection retains the original entry for every split book',
      );
    const { data, fingerprint } = await snapshot(db);
    if (
      preview.dropboxTargets.needsChoice &&
      input.dropboxTargetId === undefined
    )
      throw new CollectionError(
        400,
        'Choose one Dropbox destination or the new shared default',
      );
    const dropboxTargetId =
      input.dropboxTargetId === undefined
        ? (preview.dropboxTargets.configuredIds[0] ?? null)
        : input.dropboxTargetId || null;
    if (
      dropboxTargetId &&
      !data.collections.some((collection) => collection.id === dropboxTargetId)
    )
      throw new CollectionError(400, 'Invalid Dropbox destination');
    const owner = data.users.find((user) => user.role === 'owner');
    if (!owner) throw new CollectionError(409, 'A system owner is required');
    let plan: MigrationPlan = {
      fingerprint,
      choices: input.choices,
      defaultId: randomUUID(),
      recoveredId: randomUUID(),
      ownerId: String(owner.id),
      dropboxTargetId,
    };
    await db.transaction(async (tx) => {
      await lockCollectionChanges(tx);
      const [retained] = await tx
        .select()
        .from(systemState)
        .where(eq(systemState.key, 'collection-migration-plan'));
      if (retained) {
        plan = planValue(JSON.parse(retained.value));
        if (
          plan.fingerprint !== fingerprint ||
          plan.dropboxTargetId !== dropboxTargetId ||
          JSON.stringify(
            [...plan.choices].sort((a, b) => a.bookId.localeCompare(b.bookId)),
          ) !==
            JSON.stringify(
              [...input.choices].sort((a, b) =>
                a.bookId.localeCompare(b.bookId),
              ),
            )
        )
          throw new CollectionError(
            409,
            'Resume with the retained migration choices',
          );
      } else
        await tx.insert(systemState).values({
          key: 'collection-migration-plan',
          value: JSON.stringify(plan),
        });
      await tx
        .update(systemState)
        .set({ value: 'migrating' })
        .where(eq(systemState.key, 'collections-model'));
    });
    const copies: Array<{
      original: Row;
      row: Row & { id: string };
      collectionId: string;
      files: Awaited<ReturnType<typeof copyBookFiles>>;
    }> = [];
    for (const book of data.books) {
      const links = data.legacy_collection_books.filter(
        (link) => link.book_id === book.id,
      );
      const keep =
        plan.choices.find((choice) => choice.bookId === book.id)
          ?.collectionId ??
        links[0]?.collection_id ??
        plan.recoveredId;
      for (const link of links.filter((link) => link.collection_id !== keep)) {
        const id = copyId(String(book.id), String(link.collection_id));
        copies.push({
          original: book,
          row: {
            ...book,
            id,
            calibre_book_id: null,
            collection_id: link.collection_id ?? null,
            added_by_user_id: link.added_by_user_id ?? null,
            added_at: link.added_at ?? 0,
          },
          collectionId: String(link.collection_id),
          files: await copyBookFiles(
            root,
            book,
            data.book_files.filter((file) => file.book_id === book.id),
            id,
            fingerprint,
          ),
        });
      }
    }
    await db.transaction(async (tx) => {
      await lockCollectionChanges(tx);
      if ((await snapshot(tx)).fingerprint !== fingerprint)
        throw new CollectionError(
          409,
          'Library changed during migration. Restore the matching backup before retrying.',
        );
      const now = Math.floor(Date.now() / 1000);
      await tx.run(sql`UPDATE collections SET is_personal=0,is_default=0`);
      await tx.run(
        sql`INSERT INTO collections(id,name,owner_user_id,is_personal,is_default,created_at,updated_at) VALUES(${plan.defaultId},'Default',${plan.ownerId},0,1,${now},${now})`,
      );
      await tx.run(
        sql`INSERT INTO collection_members(collection_id,user_id,role,created_at) SELECT ${plan.defaultId},id,'editor',${now} FROM users WHERE id!=${plan.ownerId}`,
      );
      const dropbox = legacyDropbox(data);
      if (dropbox)
        await tx.run(
          sql`UPDATE global_settings SET settings=${JSON.stringify({ ...dropbox.settings, dropbox: { ...dropbox.dropbox, targetCollectionId: plan.dropboxTargetId ?? '', additionalCollectionIds: [] } })} WHERE user_id=${dropbox.row.user_id}`,
        );
      if (preview.recoveredBooks)
        await tx.run(
          sql`INSERT INTO collections(id,name,owner_user_id,is_personal,is_default,created_at,updated_at) VALUES(${plan.recoveredId},'Recovered books',${plan.ownerId},0,0,${now},${now})`,
        );
      for (const book of data.books) {
        const links = data.legacy_collection_books.filter(
          (link) => link.book_id === book.id,
        );
        const collectionId =
          plan.choices.find((choice) => choice.bookId === book.id)
            ?.collectionId ??
          links[0]?.collection_id ??
          plan.recoveredId;
        const link = links.find((link) => link.collection_id === collectionId);
        await tx.run(
          sql`UPDATE books SET collection_id=${collectionId},added_by_user_id=${link?.added_by_user_id ?? book.created_by_user_id},added_at=${link?.added_at ?? book.created_at} WHERE id=${book.id}`,
        );
      }
      for (const copy of copies) {
        await insertRow(tx, 'books', {
          ...copy.row,
          cover_image_path: copy.files.cover,
        });
        for (const table of [
          'book_authors',
          'book_tags',
          'book_identifiers',
        ] as const)
          for (const row of data[table].filter(
            (row) => row.book_id === copy.original.id,
          ))
            await insertRow(tx, table, { ...row, book_id: copy.row.id });
        for (const row of data.book_files.filter(
          (row) => row.book_id === copy.original.id,
        )) {
          const file = copy.files.files.get(String(row.relative_path));
          if (!file)
            throw new CollectionError(409, 'Missing verified book copy');
          await insertRow(tx, 'book_files', {
            ...row,
            id: randomUUID(),
            book_id: copy.row.id,
            relative_path: file,
          });
        }
        const members = new Set(
          data.collection_members
            .filter((member) => member.collection_id === copy.collectionId)
            .map((member) => member.user_id),
        );
        for (const table of readerTables)
          for (const row of data[table].filter(
            (row) =>
              row.book_id === copy.original.id &&
              members.has(row.user_id ?? null),
          ))
            await insertRow(tx, table, {
              ...row,
              ...(row.id ? { id: randomUUID() } : {}),
              book_id: copy.row.id,
            });
      }
      // Rank from the source snapshot, so trigger normalization cannot reorder untouched books.
      for (const user of data.users) {
        const queue = data.user_book_status
          .filter(
            (row) => row.user_id === user.id && row.status === 'to_be_read',
          )
          .sort(
            (a, b) =>
              Number(a.tbr_rank ?? Number.MAX_SAFE_INTEGER) -
                Number(b.tbr_rank ?? Number.MAX_SAFE_INTEGER) ||
              String(a.book_id).localeCompare(String(b.book_id)),
          );
        let rank = 0;
        for (const original of queue) {
          const ids = [
            String(original.book_id),
            ...copies
              .filter((copy) => copy.original.id === original.book_id)
              .map((copy) => String(copy.row.id)),
          ];
          for (const id of ids) {
            const [visible] = await tx.all(
              sql`SELECT 1 FROM books b JOIN collection_members cm ON cm.collection_id=b.collection_id WHERE b.id=${id} AND cm.user_id=${user.id}`,
            );
            await tx.run(
              sql`UPDATE user_book_status SET tbr_rank=${visible ? ++rank : null} WHERE user_id=${user.id} AND book_id=${id}`,
            );
          }
        }
      }
      const [invalid] = await tx.all(
        sql`SELECT 1 FROM books WHERE collection_id IS NULL LIMIT 1`,
      );
      if (invalid)
        throw new CollectionError(409, 'Migration left an unassigned book');
      await tx
        .update(systemState)
        .set({ value: 'exclusive' })
        .where(eq(systemState.key, 'collections-model'));
    });
    return { complete: true };
  });
}
