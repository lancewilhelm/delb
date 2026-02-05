import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { books, collectionBooks, collectionMembers } from '~/utils/db/schema';
import { auth } from '~/utils/auth';

export type CoverVariant = 'thumb' | 'source';

type EventLike = Parameters<typeof defineEventHandler>[0] extends (
  e: infer E,
) => unknown
  ? E
  : never;

const SOURCE_CANDIDATES = [
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'cover.webp',
  'cover.gif',
  'cover.svg',
  'cover.avif',
  'cover.tif',
  'cover.tiff',
  'cover.source.jpg',
  'cover.source.jpeg',
  'cover.source.png',
  'cover.source.webp',
  'source.jpg',
  'source.jpeg',
  'source.png',
  'source.webp',
  // Last-resort fallback for UI parity
  'thumb.webp',
] as const;

function normalizePosix(p: string): string {
  return (p ?? '')
    .toString()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function contentTypeFromExt(ext: string): string {
  const e = (ext ?? '').toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  if (e === '.svg') return 'image/svg+xml';
  if (e === '.avif') return 'image/avif';
  if (e === '.tif' || e === '.tiff') return 'image/tiff';
  return 'application/octet-stream';
}

function resolveUnderLibrary(libraryBaseAbs: string, relPosix: string): string {
  const abs = path.resolve(libraryBaseAbs, relPosix.split('/').join(path.sep));
  const relToBase = path.relative(libraryBaseAbs, abs);

  if (relToBase.startsWith('..') || relToBase.includes(`..${path.sep}`)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' });
  }

  return abs;
}

async function isFile(absPath: string): Promise<boolean> {
  try {
    const s = await stat(absPath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

function computeETag(opts: {
  bookId: string;
  variant: CoverVariant;
  size: number;
  mtimeMs: number;
}): string {
  const raw = `${opts.bookId}:${opts.variant}:${opts.size}:${Math.floor(opts.mtimeMs)}`;
  const digest = createHash('sha1').update(raw).digest('hex');
  return `"${digest}"`;
}

function normalizeIfNoneMatch(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

async function getVisibleCoverContext(event: EventLike, bookId: string): Promise<{
  coverImagePath: string;
  sessionUserId: string;
}> {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const memberships = await cloudDb
    .select({ collectionId: collectionMembers.collectionId })
    .from(collectionMembers)
    .where(eq(collectionMembers.userId, session.user.id));

  const memberCollectionIds = Array.from(
    new Set(memberships.map((m) => m.collectionId)),
  ).filter(Boolean);

  if (!memberCollectionIds.length) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }

  const visible = await cloudDb
    .select({ coverImagePath: books.coverImagePath })
    .from(books)
    .innerJoin(
      collectionBooks,
      and(eq(collectionBooks.bookId, books.id), eq(books.id, bookId)),
    )
    .where(inArray(collectionBooks.collectionId, memberCollectionIds))
    .limit(1);

  const coverImagePath = (visible[0]?.coverImagePath ?? '').toString().trim();
  if (!coverImagePath) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }

  return { coverImagePath, sessionUserId: session.user.id };
}

export async function resolveBookCoverFile(opts: {
  event: EventLike;
  bookId: string;
  variant: CoverVariant;
}): Promise<{
  absPath: string;
  contentType: string;
  etag: string;
  bytes: Buffer;
}> {
  const { coverImagePath } = await getVisibleCoverContext(opts.event, opts.bookId);

  const libraryBaseAbs = path.resolve(process.cwd(), 'library');
  const relFromLibrary = normalizePosix(coverImagePath).replace(/^library\//, '');
  const coverDirPosix = path.posix.dirname(relFromLibrary);

  let chosenAbs: string | null = null;

  if (opts.variant === 'thumb') {
    const thumbRel = coverDirPosix === '.' ? 'thumb.webp' : `${coverDirPosix}/thumb.webp`;
    const thumbAbs = resolveUnderLibrary(libraryBaseAbs, thumbRel);

    if (await isFile(thumbAbs)) {
      chosenAbs = thumbAbs;
    } else {
      const coverAbs = resolveUnderLibrary(libraryBaseAbs, relFromLibrary);
      if (await isFile(coverAbs)) {
        chosenAbs = coverAbs;
      }
    }
  } else {
    const unique = Array.from(new Set(SOURCE_CANDIDATES));
    for (const candidate of unique) {
      const relPosix = coverDirPosix === '.' ? candidate : `${coverDirPosix}/${candidate}`;
      const abs = resolveUnderLibrary(libraryBaseAbs, relPosix);
      if (await isFile(abs)) {
        chosenAbs = abs;
        break;
      }
    }
  }

  if (!chosenAbs) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }

  const s = await stat(chosenAbs);
  const ext = path.extname(chosenAbs);

  const etag = computeETag({
    bookId: opts.bookId,
    variant: opts.variant,
    size: s.size,
    mtimeMs: s.mtimeMs,
  });

  const bytes = await readFile(chosenAbs);

  return {
    absPath: chosenAbs,
    contentType: contentTypeFromExt(ext),
    etag,
    bytes,
  };
}

export function shouldReturnNotModified(opts: {
  requestHeaders: Headers | Record<string, string | string[] | undefined>;
  etag: string;
}): boolean {
  const h = opts.requestHeaders;
  const raw =
    h instanceof Headers
      ? h.get('if-none-match') ?? undefined
      : (h['if-none-match'] as string | undefined);

  const provided = normalizeIfNoneMatch(raw);
  if (!provided.length) return false;

  return provided.includes(opts.etag) || provided.includes('*');
}
