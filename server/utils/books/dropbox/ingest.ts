import path from 'node:path';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  readdir,
  rm,
  unlink,
} from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { authors, bookAuthors, bookFiles, books, collectionBooks } from '~/utils/db/schema';
import { logger } from '~/utils/logger';

import { parseEpubMetadataFromBuffer } from '~~/server/utils/books/epub';
import { extractAndStoreEpubCover } from '~~/server/utils/books/epub-cover';
import { toSafePathSegment } from '~~/server/utils/books/fs';
import { buildBookStorageRelativePath } from '~~/server/utils/books/storage/paths';
import { normalizePublishedAt } from '~~/server/utils/books/published';
import { makeAuthorSortKey, makeTitleSortKey } from '~~/server/utils/sort/keys';

import type { DropboxTarget } from './target';

type SupportedBookFormat = 'epub' | 'pdf' | 'mobi' | 'azw3';
const SUPPORTED_BOOK_FORMATS: ReadonlyArray<SupportedBookFormat> = [
  'epub',
  'pdf',
  'mobi',
  'azw3',
];

type ParsedBookMetadata = {
  title: string;
  author: string;
  description?: string;
  language?: string;
  published?: string;
};

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
      statusMessage: `Unsupported format. Supported: ${SUPPORTED_BOOK_FORMATS.map((x) => `.${x}`).join(', ')}`,
    });
  }
  return ext;
}

async function parseNonEpubMetadataFromFilename(filename: string): Promise<ParsedBookMetadata> {
  const fallbackTitle = path.basename(filename, path.extname(filename));
  return { title: fallbackTitle || 'Untitled', author: 'Unknown Author' };
}

async function parseBookMetadataFromBuffer(opts: {
  buffer: Buffer;
  format: SupportedBookFormat;
  filename: string;
}): Promise<ParsedBookMetadata> {
  const fallbackTitle = path.basename(opts.filename, path.extname(opts.filename));

  if (opts.format === 'epub') {
    const meta = await parseEpubMetadataFromBuffer(opts.buffer, { fallbackTitle });
    return {
      title: meta.title || fallbackTitle || 'Untitled',
      author: meta.author || 'Unknown Author',
      description: meta.description,
      language: meta.language,
      published: meta.published,
    };
  }

  return await parseNonEpubMetadataFromFilename(opts.filename);
}

type DbLike = Pick<typeof cloudDb, 'select' | 'insert'>;

async function findOrCreateAuthorByName(db: DbLike, name: string) {
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

async function moveFileAbs(sourceAbs: string, destAbs: string) {
  try {
    await rename(sourceAbs, destAbs);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== 'EXDEV') throw err;
    await copyFile(sourceAbs, destAbs);
    await unlink(sourceAbs);
  }
}

async function tryRemoveDirIfEmpty(dirAbs: string) {
  try {
    const entries = await readdir(dirAbs);
    if (entries.length > 0) return;
    await rm(dirAbs, { recursive: false, force: true });
  } catch {
    // ignore
  }
}

export type DropboxIngestResult = {
  bookId: string;
  relativePath: string;
  title: string;
  author: string;
  format: SupportedBookFormat;
};

export async function ingestDropboxFile(opts: {
  fileAbs: string;
  originalFilename: string;
  target: DropboxTarget;
}): Promise<DropboxIngestResult> {
  const format = ensureSupportedBookFormat(opts.originalFilename);
  const buffer = await readFile(opts.fileAbs);

  const meta = await parseBookMetadataFromBuffer({
    buffer,
    format,
    filename: opts.originalFilename,
  });

  const authorName = meta.author || 'Unknown Author';
  const title = meta.title || 'Untitled';

  const bookId = crypto.randomUUID();
  const safeTitle = toSafePathSegment(title, 'Untitled');

  const relativePath = buildBookStorageRelativePath({
    authorNames: [authorName],
    title,
    bookId,
    filename: `${safeTitle}.${format}`,
    baseDir: 'library',
  });

  const absoluteDest = path.resolve(process.cwd(), relativePath);
  const bookDirAbs = path.dirname(absoluteDest);

  await mkdir(bookDirAbs, { recursive: true });
  await moveFileAbs(opts.fileAbs, absoluteDest);

  let coverImagePath: string | null = null;
  if (format === 'epub') {
    try {
      const thumbRelativePath = buildBookStorageRelativePath({
        authorNames: [authorName],
        title,
        bookId,
        filename: 'thumb.webp',
        baseDir: 'library',
      });

      const sourceRelativePath = buildBookStorageRelativePath({
        authorNames: [authorName],
        title,
        bookId,
        filename: 'source.bin',
        baseDir: 'library',
      });

      const extracted = await extractAndStoreEpubCover({
        epubFilePath: absoluteDest,
        outputDirAbsolute: bookDirAbs,
        outputThumbRelativePathPosix: thumbRelativePath,
        outputSourceRelativePathPosix: sourceRelativePath,
        maxWidth: 320,
        webpQuality: 80,
      });

      coverImagePath = extracted?.thumbRelativePath ?? null;
    } catch (error) {
      logger.debug(
        error,
        'dropbox: failed to extract cover (continuing without cover)',
      );
      coverImagePath = null;
    }
  }

  const now = new Date();
  const published = (meta.published || null) as string | null;
  const publishedAt = published ? normalizePublishedAt(published) : null;

  try {
    await cloudDb.transaction(async (tx) => {
      await tx.insert(books).values({
        id: bookId,
        title,
        sortTitle: makeTitleSortKey(title),
        description: (meta.description || null) as string | null,
        published,
        publishedAt,
        language: (meta.language || null) as string | null,
        coverImagePath,
        createdByUserId: opts.target.addedByUserId,
        createdAt: now,
        updatedAt: now,
      });

      const author = await findOrCreateAuthorByName(tx as unknown as DbLike, authorName);
      await tx.insert(bookAuthors).values({
        bookId,
        authorId: author.id,
        position: 1,
      });

      await tx.insert(bookFiles).values({
        id: crypto.randomUUID(),
        bookId,
        format,
        relativePath,
        createdAt: now,
      });

      await tx.insert(collectionBooks).values({
        collectionId: opts.target.collectionId,
        bookId,
        addedByUserId: opts.target.addedByUserId,
        addedAt: now,
      });
    });
  } catch (err) {
    // Try to clean up the moved file to avoid "orphaned on disk" entries.
    try {
      await unlink(absoluteDest);
    } catch {
      // ignore
    }
    try {
      await tryRemoveDirIfEmpty(bookDirAbs);
    } catch {
      // ignore
    }
    throw err;
  }

  return { bookId, relativePath, title, author: authorName, format };
}
