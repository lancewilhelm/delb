import { and, eq } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionMembers } from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';
import { buildBookCoverUrl } from '~~/server/utils/books/cover-url';
import type { H3Event } from 'h3';
import { entityListQuery, type EntityKind } from './entity-list-query';

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number)
    ? Math.max(min, Math.min(max, number))
    : fallback;
}

type Row = {
  id: string;
  name: string;
  bookCount: number;
  bookId: string | null;
  title: string | null;
  coverImagePath: string | null;
  updatedAt: number | null;
  seriesIndex: number | null;
};

export async function listEntities(event: H3Event, kind: EntityKind) {
  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }
  const query = getQuery(event);
  const collectionId =
    typeof query.collectionId === 'string' ? query.collectionId : undefined;
  if (collectionId) {
    const membership = await cloudDb
      .select({ id: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(
        and(
          eq(collectionMembers.collectionId, collectionId),
          eq(collectionMembers.userId, session.user.id),
        ),
      )
      .limit(1);
    if (!membership.length) {
      setResponseStatus(event, 403);
      return { success: false, message: 'Forbidden' };
    }
  }
  const limit = boundedInteger(query.limit, 50, 1, 100);
  const offset = boundedInteger(query.offset, 0, 0, 1000000000);
  // -1 explicitly requests all covers for the current entity page.
  const previewLimit = boundedInteger(
    query.previewLimit,
    8,
    -1,
    Number.MAX_SAFE_INTEGER,
  );
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  try {
    const rows = await cloudDb.all<Row>(
      entityListQuery({
        kind,
        userId: session.user.id,
        collectionId,
        search,
        limit,
        offset,
        previewLimit,
      }),
    );
    const result = new Map<
      string,
      {
        id: string;
        name: string;
        bookCount: number;
        books: Array<{
          id: string;
          title: string;
          coverImagePath: string;
          coverThumbnailUrl: string;
          seriesIndex: number | null;
        }>;
      }
    >();
    for (const row of rows) {
      let entity = result.get(row.id);
      if (!entity) {
        entity = {
          id: row.id,
          name: row.name,
          bookCount: Number(row.bookCount),
          books: [],
        };
        result.set(row.id, entity);
      }
      if (row.bookId && row.coverImagePath)
        entity.books.push({
          id: row.bookId,
          title: row.title ?? '',
          coverImagePath: row.coverImagePath,
          coverThumbnailUrl: buildBookCoverUrl({
            bookId: row.bookId,
            updatedAt: row.updatedAt === null ? null : row.updatedAt * 1000,
            variant: 'thumb',
          }),
          seriesIndex: row.seriesIndex,
        });
    }
    const all = [...result.values()];
    return {
      success: true,
      data: { [kind]: all.slice(0, limit), hasMore: all.length > limit },
    };
  } catch (error: unknown) {
    logger.error(error, `GET /api/${kind}: failed`);
    throw createError({
      statusCode: 500,
      statusMessage: `Failed to load ${kind}`,
    });
  }
}
