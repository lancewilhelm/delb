import {
  resolveBookTarget,
  assertCollectionEditor,
  lockCollectionChanges,
  type CollectionConnection,
} from '~~/server/utils/collections/model';
import { eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  bookIdentifiers,
  bookTags,
  books,
  publishers,
  series,
  tags,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';
import { makeAuthorSortKey, makeTitleSortKey } from '~~/server/utils/sort/keys';
import { normalizePublishedAt } from '~~/server/utils/books/published';

interface CreateBookBody {
  title?: string | null;
  authors?: string[] | null;
  tags?: string[] | null;
  description?: string | null;
  published?: string | null;
  language?: string | null;
  pages?: number | null;
  publisherName?: string | null;
  seriesName?: string | null;
  seriesIndex?: number | null;
  identifiers?: string | null;
  collectionIds?: string[];
}

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined; // not provided
  if (value === null) return null; // explicit clear
  if (typeof value !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid string value',
    });
  }
  const v = value.trim();
  return v.length ? v : null;
}

function normalizeOptionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid number value',
    });
  }
  return value;
}

function normalizeOptionalInteger(value: unknown): number | null | undefined {
  const n = normalizeOptionalNumber(value);
  if (n === undefined) return undefined;
  if (n === null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid integer value',
    });
  }
  return n;
}

function normalizeOptionalStringArray(
  value: unknown,
  opts?: { fieldName?: string; normalizeSpaces?: boolean },
): string[] | null | undefined {
  const fieldName = opts?.fieldName ?? 'value';
  const normalizeSpaces = opts?.normalizeSpaces ?? true;

  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid ${fieldName} value`,
    });
  }

  const cleaned = value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .map((v) => (normalizeSpaces ? v.replace(/\s+/g, ' ').trim() : v.trim()))
    .filter((v) => v.length > 0);

  return cleaned.length ? cleaned : null;
}

function normalizeIdentifierType(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeIdentifierValue(value: string): string {
  return value.trim().replace(/\s+/g, '').replace(/-/g, '');
}

function parseIdentifiersFromBody(
  value: unknown,
): Array<{ type: string; value: string }> | null | undefined {
  const raw = normalizeOptionalString(value);
  if (raw === undefined) return undefined;
  if (raw === null) return null;

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const out: Array<{ type: string; value: string }> = [];

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;

    const t = normalizeIdentifierType(line.slice(0, idx));
    const v = normalizeIdentifierValue(line.slice(idx + 1));

    if (!t || !v) continue;
    out.push({ type: t, value: v });
  }

  const byType = new Map<string, string>();
  for (const row of out) byType.set(row.type, row.value);

  return Array.from(byType.entries()).map(([type, value]) => ({ type, value }));
}

async function findOrCreateAuthorByName(
  name: string,
  db: CollectionConnection,
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

async function findOrCreateTagByName(name: string, db: CollectionConnection) {
  const existing = await db
    .select()
    .from(tags)
    .where(eq(tags.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(tags).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

async function findOrCreatePublisherByName(
  name: string,
  db: CollectionConnection,
) {
  const existing = await db
    .select()
    .from(publishers)
    .where(eq(publishers.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(publishers).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

async function findOrCreateSeriesByName(
  name: string,
  db: CollectionConnection,
) {
  const existing = await db
    .select()
    .from(series)
    .where(eq(series.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(series).values({
    id,
    name,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name };
}

export default defineEventHandler(async (event) => {
  logger.debug('POST /api/books');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const userId = session.user.id;

  const body = (await readBody(event)) as CreateBookBody | null;
  if (!body || typeof body !== 'object') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing request body',
    });
  }

  const title = normalizeOptionalString(body.title);
  if (!title) {
    throw createError({ statusCode: 400, statusMessage: 'Title is required' });
  }

  const authorNames = normalizeOptionalStringArray(body.authors, {
    fieldName: 'authors',
    normalizeSpaces: true,
  });
  if (!authorNames || !authorNames.length) {
    throw createError({
      statusCode: 400,
      statusMessage: 'At least one author is required',
    });
  }

  const collectionId = await resolveBookTarget(
    cloudDb,
    userId,
    body.collectionIds,
  );

  const description = normalizeOptionalString(body.description) ?? null;
  const published = normalizeOptionalString(body.published) ?? null;
  const publishedAt = published ? normalizePublishedAt(published) : null;
  const language = normalizeOptionalString(body.language) ?? null;
  const pages = normalizeOptionalInteger(body.pages) ?? null;

  const publisherName = normalizeOptionalString(body.publisherName);
  const seriesName = normalizeOptionalString(body.seriesName);
  const seriesIndex = normalizeOptionalNumber(body.seriesIndex) ?? null;

  const tagNames =
    normalizeOptionalStringArray(body.tags, {
      fieldName: 'tags',
      normalizeSpaces: true,
    }) ?? [];

  const identifiers = parseIdentifiersFromBody(body.identifiers) ?? [];

  const now = new Date();
  const bookId = crypto.randomUUID();

  return cloudDb.transaction(async (tx) => {
    await lockCollectionChanges(tx);
    await assertCollectionEditor(tx, userId, collectionId);
    const publisherId = publisherName
      ? (await findOrCreatePublisherByName(publisherName, tx)).id
      : null;
    const seriesId = seriesName
      ? (await findOrCreateSeriesByName(seriesName, tx)).id
      : null;

    await tx.insert(books).values({
      id: bookId,
      collectionId,
      addedByUserId: userId,
      addedAt: now,
      title,
      sortTitle: makeTitleSortKey(title),
      description,
      published,
      publishedAt,
      language,
      pages,
      publisherId,
      seriesId,
      seriesIndex,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    });

    let pos = 1;
    for (const name of authorNames) {
      const author = await findOrCreateAuthorByName(name, tx);
      await tx
        .insert(bookAuthors)
        .values({ bookId, authorId: author.id, position: pos })
        .onConflictDoNothing();
      pos += 1;
    }

    for (const name of tagNames) {
      const tag = await findOrCreateTagByName(name, tx);
      await tx
        .insert(bookTags)
        .values({ bookId, tagId: tag.id })
        .onConflictDoNothing();
    }

    for (const ident of identifiers) {
      await tx
        .insert(bookIdentifiers)
        .values({ bookId, type: ident.type, value: ident.value })
        .onConflictDoUpdate({
          target: [bookIdentifiers.bookId, bookIdentifiers.type],
          set: { value: ident.value },
        });
    }

    return {
      success: true,
      data: {
        book: {
          id: bookId,
          title,
        },
      },
    };
  });
});
