import {
  resolveBookTarget,
  assertBookEditor,
  lockCollectionChanges,
  CollectionError,
  type CollectionConnection,
} from '~~/server/utils/collections/model';
import path from 'node:path';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';

import { and, eq, ne } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  bookFiles,
  bookIdentifiers,
  books,
  collectionMembers,
  collectionBooks,
  storageOperations,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

import { parseEpubMetadataFromBuffer } from '~~/server/utils/books/epub';
import { extractAndStoreEpubCover } from '~~/server/utils/books/epub-cover';
import { resolveDataPath, toSafePathSegment } from '~~/server/utils/books/fs';
import { makeAuthorSortKey, makeTitleSortKey } from '~~/server/utils/sort/keys';
import { buildBookStorageRelativePath } from '~~/server/utils/books/storage/paths';
import { normalizePublishedAt } from '~~/server/utils/books/published';
import { withBookStorageLock } from '~~/server/utils/books/storage/book-lock';
import { deleteStoredFiles } from '~~/server/utils/books/storage/delete-operation';
import { deleteDecision } from '~~/server/utils/books/storage/delete-recovery';
import { beginStoredCreate } from '~~/server/utils/books/storage/create-operation';
import { createDecision } from '~~/server/utils/books/storage/create-recovery';
import { findPossibleDuplicates } from '~~/server/utils/books/duplicates';
import { cacheBoundedRequestBody } from '~~/server/utils/books/storage/bounded-upload';

type SupportedBookFormat = 'epub' | 'pdf' | 'mobi' | 'azw3';
const SUPPORTED_BOOK_FORMATS: ReadonlyArray<SupportedBookFormat> = [
  'epub',
  'pdf',
  'mobi',
  'azw3',
];

/**
 * Get the extension of a filename.
 * @param filename
 * @returns
 */
function getExtension(filename: string): string {
  const ext = path.extname(filename || '').toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

function isSupportedBookFormat(ext: string): ext is SupportedBookFormat {
  return (SUPPORTED_BOOK_FORMATS as ReadonlyArray<string>).includes(ext);
}

function ensureSupportedBookFormat(filename: string): SupportedBookFormat {
  const ext = getExtension(filename);
  if (!ext || !isSupportedBookFormat(ext)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unsupported upload format. Supported: ${SUPPORTED_BOOK_FORMATS.map((x) => `.${x}`).join(', ')}`,
    });
  }
  return ext;
}

type ParsedBookMetadata = {
  /** Display title */
  title: string;
  /** Display author (v1: single author string) */
  author: string;
  identifiers?: Array<{ type: string; value: string }>;
  description?: string;
  language?: string;
  published?: string;
};

type MultipartFilePart = {
  name?: string;
  filename?: string;
  type?: string;
  data?: Buffer;
};

/**
 * Skeleton metadata parsing for non-EPUB formats.
 * This intentionally does not attempt to parse real metadata yet.
 */
async function parseNonEpubMetadataFromBuffer(opts: {
  buffer: Buffer;
  format: Exclude<SupportedBookFormat, 'epub'>;
  filename: string;
  fallbackTitle: string;
}): Promise<ParsedBookMetadata> {
  // TODO: Implement per-format parsing later:
  // - pdf: read document info dictionary (Title/Author/Subject/Keywords)
  // - mobi/azw3: parse Kindle headers + EXTH records
  // For MVP: use safe fallbacks derived from filename.
  void opts.buffer;
  void opts.format;
  void opts.filename;

  return {
    title: opts.fallbackTitle || 'Untitled',
    author: 'Unknown Author',
  };
}

async function parseBookMetadataFromBuffer(opts: {
  buffer: Buffer;
  format: SupportedBookFormat;
  filename: string;
}): Promise<ParsedBookMetadata> {
  const fallbackTitle = path.basename(
    opts.filename,
    path.extname(opts.filename),
  );

  if (opts.format === 'epub') {
    const meta = await parseEpubMetadataFromBuffer(opts.buffer, {
      fallbackTitle,
    });

    return {
      title: meta.title || fallbackTitle || 'Untitled',
      author: meta.author || 'Unknown Author',
      identifiers: [
        meta.ISBN ? { type: 'isbn', value: meta.ISBN } : null,
        meta.UUID ? { type: 'uuid', value: meta.UUID } : null,
      ].filter((x): x is { type: string; value: string } =>
        Boolean(x && x.type && x.value),
      ),
      description: meta.description,
      language: meta.language,
      published: meta.published,
    };
  }

  return await parseNonEpubMetadataFromBuffer({
    buffer: opts.buffer,
    format: opts.format,
    filename: opts.filename,
    fallbackTitle,
  });
}

/**
 * Ensure the user can add books to every target collection.
 */
async function findOrCreateAuthorByName(
  db: CollectionConnection,
  name: string,
) {
  const existing = await db
    .select()
    .from(authors)
    .where(eq(authors.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(authors).values({
    id,
    name,
    sortName: makeAuthorSortKey(name),
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

/**
 * Process a single book upload (EPUB/PDF/MOBI/AZW3).
 * @param filePart
 * @param input
 * @returns object containing the book's metadata and stored file path
 */
async function processOneBookUploadUnlocked(
  filePart: MultipartFilePart,
  input: {
    userId: string;
    userRole: string;
    collectionIds: string[];
    allowDuplicate?: boolean;
    replaceBookId?: string | null;
  },
  newBookId: string,
) {
  if (!filePart.filename || !filePart.data) {
    throw createError({ statusCode: 400, statusMessage: 'Missing book file' });
  }

  const format = ensureSupportedBookFormat(filePart.filename);

  // Parse metadata (EPUB implemented, others skeleton)
  const meta = await parseBookMetadataFromBuffer({
    buffer: filePart.data,
    format,
    filename: filePart.filename,
  });

  const authorName = meta.author || 'Unknown Author';
  const title = meta.title || 'Untitled';

  let existingCoverImagePath: string | null = null;
  if (input.replaceBookId) {
    if (!input.allowDuplicate) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Missing allowDuplicate for replace',
      });
    }

    const existing = await cloudDb
      .select()
      .from(books)
      .where(eq(books.id, input.replaceBookId))
      .limit(1);
    const book = existing[0];
    if (!book) throw new CollectionError(404, 'Book not found');
    const source = await assertBookEditor(cloudDb, input.userId, book.id);
    if (input.collectionIds.length !== 1 || source !== input.collectionIds[0])
      throw new CollectionError(
        409,
        'Replacement must stay in the existing collection. Create an independent entry instead.',
      );
    existingCoverImagePath = book.coverImagePath;
    const visible = await cloudDb
      .select({ bookId: collectionBooks.bookId })
      .from(collectionBooks)
      .innerJoin(
        collectionMembers,
        eq(collectionMembers.collectionId, collectionBooks.collectionId),
      )
      .where(
        and(
          eq(collectionBooks.bookId, input.replaceBookId),
          eq(collectionMembers.userId, input.userId),
        ),
      )
      .limit(1);
    if (!visible.length)
      throw createError({ statusCode: 404, statusMessage: 'Book not found' });
  }

  if (!input.allowDuplicate) {
    const candidates = await findPossibleDuplicates({
      userId: input.userId,
      title,
      author: authorName,
      identifiers: meta.identifiers ?? [],
      maxCandidates: 8,
    });

    if (candidates.length) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Possible duplicate',
        data: {
          code: 'possible_duplicate',
          incoming: {
            title,
            author: authorName,
            identifiers: meta.identifiers ?? [],
            filename: filePart.filename,
          },
          candidates,
        },
      });
    }
  }

  const safeTitle = toSafePathSegment(title, 'Untitled');

  const id = input.replaceBookId ?? newBookId;
  const relativePath = buildBookStorageRelativePath({
    authorNames: [authorName],
    title,
    bookId: id,
    filename: `${safeTitle}-${crypto.randomUUID()}.${format}`,
    baseDir: 'library',
  });

  const absolutePath = resolveDataPath(relativePath);
  const bookDirAbsolute = path.dirname(absolutePath);

  let creation: Awaited<ReturnType<typeof beginStoredCreate>> | undefined;
  if (input.replaceBookId) {
    await mkdir(bookDirAbsolute, { recursive: true });
  } else {
    creation = await beginStoredCreate({
      root: path.resolve(process.cwd(), 'library'),
      bookId: id,
      directory: bookDirAbsolute,
      file: absolutePath,
      decision: createDecision,
    });
  }
  let finalizingCreation = false;
  try {
    await writeFile(absolutePath, filePart.data, { flag: 'wx' });
    const handle = await open(absolutePath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!(await readFile(absolutePath)).equals(filePart.data)) {
      throw new Error('Uploaded file failed verification');
    }

    // Best-effort cover extraction (EPUB only for now)
    //
    // New cover storage model:
    // - Store extracted original cover bytes as: `source.<ext>` (true original, full resolution)
    // - Store a 320px-wide thumbnail as: `thumb.webp` (used almost everywhere)
    // - Persist `books.coverImagePath` as the thumbnail path (`thumb.webp`)
    //
    // The full-res source is served only on-demand by requesting its path.
    let coverImagePath: string | null = existingCoverImagePath;
    if (format === 'epub' && !input.replaceBookId) {
      try {
        const thumbRelativePath = buildBookStorageRelativePath({
          authorNames: [authorName],
          title,
          bookId: id,
          filename: 'thumb.webp',
          baseDir: 'library',
        });

        const sourceRelativePath = buildBookStorageRelativePath({
          authorNames: [authorName],
          title,
          bookId: id,
          filename: 'source.bin',
          baseDir: 'library',
        });

        const extracted = await extractAndStoreEpubCover({
          epubFilePath: absolutePath,
          outputDirAbsolute: bookDirAbsolute,
          outputThumbRelativePathPosix: thumbRelativePath,
          outputSourceRelativePathPosix: sourceRelativePath,
          maxWidth: 320,
          webpQuality: 80,
        });

        // Store thumbnail path in DB
        coverImagePath = extracted?.thumbRelativePath ?? null;
      } catch (error) {
        logger.debug(
          error,
          'POST /api/books/upload: Failed to extract cover (continuing without cover)',
        );
        coverImagePath = null;
      }
    }

    const now = new Date();

    // Create canonical book record
    const published = (meta.published || null) as string | null;
    const publishedAt = published ? normalizePublishedAt(published) : null;

    const persist = async (operationId?: string) =>
      await cloudDb.transaction(async (tx) => {
        await lockCollectionChanges(tx);
        const collectionId = await resolveBookTarget(
          tx,
          input.userId,
          input.collectionIds,
        );
        if (
          input.replaceBookId &&
          (await assertBookEditor(tx, input.userId, id)) !== collectionId
        )
          throw new CollectionError(
            409,
            'The source collection changed. Review the import again.',
          );
        if (operationId)
          await tx.insert(storageOperations).values({
            id: operationId,
            bookId: id,
            kind: input.replaceBookId ? 'replace' : 'create',
            createdAt: now,
          });
        if (input.replaceBookId) {
          await tx
            .update(books)
            .set({
              title,
              sortTitle: makeTitleSortKey(title),
              description: meta.description || null,
              published,
              publishedAt,
              language: meta.language || null,
              updatedAt: now,
            })
            .where(eq(books.id, id));
          await tx.delete(bookAuthors).where(eq(bookAuthors.bookId, id));
          await tx
            .delete(bookIdentifiers)
            .where(eq(bookIdentifiers.bookId, id));
          await tx.delete(bookFiles).where(eq(bookFiles.bookId, id));
        } else {
          await tx.insert(books).values({
            id,
            collectionId,
            addedByUserId: input.userId,
            addedAt: now,
            title,
            sortTitle: makeTitleSortKey(title),
            description: meta.description || null,
            published,
            publishedAt,
            language: meta.language || null,
            coverImagePath,
            createdByUserId: input.userId,
            createdAt: now,
            updatedAt: now,
          });
        }
        const author = await findOrCreateAuthorByName(tx, authorName);
        await tx
          .insert(bookAuthors)
          .values({ bookId: id, authorId: author.id, position: 1 });
        await tx.insert(bookFiles).values({
          id: crypto.randomUUID(),
          bookId: id,
          format,
          relativePath,
          createdAt: now,
        });
        for (const ident of meta.identifiers ?? []) {
          const type = (ident.type ?? '').trim().toLowerCase();
          const value = (ident.value ?? '').trim();
          if (type && value)
            await tx
              .insert(bookIdentifiers)
              .values({ bookId: id, type, value });
        }
      });
    if (input.replaceBookId) {
      const oldFiles = await cloudDb
        .select({ relativePath: bookFiles.relativePath })
        .from(bookFiles)
        .where(eq(bookFiles.bookId, id));
      const sources: string[] = [];
      for (const file of oldFiles) {
        if (!file.relativePath || file.relativePath === existingCoverImagePath)
          continue;
        const [sharedFiles, sharedCovers] = await Promise.all([
          cloudDb
            .select({ id: bookFiles.id })
            .from(bookFiles)
            .where(
              and(
                eq(bookFiles.relativePath, file.relativePath),
                ne(bookFiles.bookId, id),
              ),
            )
            .limit(1),
          cloudDb
            .select({ id: books.id })
            .from(books)
            .where(
              and(
                eq(books.coverImagePath, file.relativePath),
                ne(books.id, id),
              ),
            )
            .limit(1),
        ]);
        if (!sharedFiles.length && !sharedCovers.length)
          sources.push(resolveDataPath(file.relativePath));
      }
      await deleteStoredFiles({
        root: path.resolve(process.cwd(), 'library'),
        bookId: id,
        sources,
        decision: deleteDecision,
        commit: persist,
      });
    } else {
      await persist(creation?.id);
    }
    finalizingCreation = true;
    await creation?.finish();

    return {
      id,
      title,
      author: authorName,
      format,
      relativePath,
      coverImagePath,
      createdAt: now,
    };
  } catch (error) {
    if (creation && !finalizingCreation) {
      try {
        await creation.finish();
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          'Upload failed and recovery is pending',
        );
      }
    }
    throw error;
  }
}

async function processOneBookUpload(
  filePart: MultipartFilePart,
  input: Parameters<typeof processOneBookUploadUnlocked>[1],
) {
  const bookId = input.replaceBookId ?? crypto.randomUUID();
  return await withBookStorageLock(
    path.resolve(process.cwd(), 'library'),
    bookId,
    async () => await processOneBookUploadUnlocked(filePart, input, bookId),
  );
}

export default defineEventHandler(async (event) => {
  logger.debug('POST /api/books/upload');

  // Require auth (consistent with the app's home page)
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;

  await cacheBoundedRequestBody(
    event.node.req,
    event.node.res,
    100 * 1024 * 1024,
  );
  const form = await readMultipartFormData(event);
  if (!form?.length) {
    throw createError({ statusCode: 400, statusMessage: 'Missing form data' });
  }

  const incomingTargets = form
    .filter((part) => part.name === 'collectionId')
    .map((part) => part.data.toString());
  const collectionId = await resolveBookTarget(
    cloudDb,
    userId,
    incomingTargets,
  );
  const collectionIds = [collectionId];

  // Find all file parts (client may send multiple "file" entries)
  const fileParts = form.filter(
    (p) => p.type && p.filename && p.data,
  ) as MultipartFilePart[];

  if (!fileParts.length) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing book file(s)',
    });
  }

  const allowDuplicate = form
    .filter((p) => p.name === 'allowDuplicate')
    .map((p) => (typeof p.data === 'string' ? p.data : p.data?.toString()))
    .some((v) => {
      const s = (v ?? '').toString().trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === 'on';
    });

  const replaceBookId =
    form
      .filter((p) => p.name === 'replaceBookId')
      .map((p) => (typeof p.data === 'string' ? p.data : p.data?.toString()))
      .map((s) => (s ?? '').toString().trim())
      .find((s) => s.length > 0) ?? null;

  if (replaceBookId && !allowDuplicate) {
    throw createError({
      statusCode: 400,
      statusMessage: 'replaceBookId requires allowDuplicate=1',
    });
  }

  if (replaceBookId && fileParts.length !== 1) {
    throw createError({
      statusCode: 400,
      statusMessage: 'replaceBookId is only supported for single-file uploads',
    });
  }

  const results: Array<{
    success: boolean;
    book?: unknown;
    filename?: string;
    error?: string;
    code?: string;
    details?: unknown;
  }> = [];

  for (const part of fileParts) {
    try {
      const book = await processOneBookUpload(part, {
        userId,
        userRole: session.user.role,
        collectionIds,
        allowDuplicate,
        replaceBookId,
      });
      results.push({ success: true, book, filename: part.filename });
    } catch (err: unknown) {
      logger.error(err, 'POST /api/books/upload: Failed to process one upload');

      const e = err as {
        data?: { message?: string };
        statusMessage?: string;
        message?: string;
      };

      results.push({
        success: false,
        filename: part.filename,
        error:
          e?.data?.message ||
          e?.statusMessage ||
          e?.message ||
          'Failed to upload file',
        code:
          e && typeof e === 'object' && 'data' in e
            ? ((e as { data?: { code?: unknown } })?.data?.code as
                string | undefined)
            : undefined,
        details:
          e && typeof e === 'object' && 'data' in e
            ? (e as { data?: unknown }).data
            : undefined,
      });
    }
  }

  const uploaded = results.filter((r) => r.success).map((r) => r.book);

  return {
    success: true,
    data: {
      uploaded,
      results,
    },
  };
});
