import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  authors,
  bookAuthors,
  books,
  collectionBooks,
  collectionMembers,
  publishers,
  series,
  userBookStatus,
  USER_BOOK_STATUSES,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

type SortKey = 'dateAdded' | 'alphabetical' | 'publishedDate';
type SortDir = 'asc' | 'desc';

type UserBookStatusValue = (typeof USER_BOOK_STATUSES)[number];

type Cursor = {
  /**
   * Cursor payload depends on sort key:
   * - dateAdded: createdAt + id
   * - alphabetical: sortTitle + id
   * - publishedDate: published + id
   */
  v: string;
  id: string;
};

function clampInt(
  input: unknown,
  opts: { min: number; max: number; fallback: number },
): number {
  const n = Number.parseInt((input ?? '').toString(), 10);
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, n));
}

function normalizeSortKey(raw: unknown): SortKey {
  const v = (raw ?? '').toString().trim();
  if (v === 'alphabetical') return 'alphabetical';
  if (v === 'publishedDate') return 'publishedDate';
  return 'dateAdded';
}

function normalizeSortDir(raw: unknown, sort: SortKey): SortDir {
  const v = (raw ?? '').toString().trim().toLowerCase();
  if (v === 'asc') return 'asc';
  if (v === 'desc') return 'desc';

  // Default directions
  if (sort === 'alphabetical') return 'asc';
  return 'desc';
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<Cursor>;
    const v = (parsed.v ?? '').toString();
    const id = (parsed.id ?? '').toString().trim();
    if (!id) return null;
    // v may be "" (e.g. missing published), but must exist to keep cursor shape stable
    return { v, id };
  } catch {
    return null;
  }
}

function normalizeStatusFilter(
  raw: unknown,
): { statuses: UserBookStatusValue[]; includeNone: boolean } {
  const v = (raw ?? '').toString().trim();
  if (!v) return { statuses: [], includeNone: false };

  const parts = v
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const uniq = Array.from(new Set(parts));

  const statuses: UserBookStatusValue[] = [];
  let includeNone = false;

  for (const token of uniq) {
    if (token === 'none') {
      includeNone = true;
      continue;
    }

    if ((USER_BOOK_STATUSES as readonly string[]).includes(token)) {
      statuses.push(token as UserBookStatusValue);
      continue;
    }

    throw createError({
      statusCode: 400,
      statusMessage: `Invalid status filter. Expected one of: ${USER_BOOK_STATUSES.join(
        ', ',
      )}, none`,
    });
  }

  return { statuses, includeNone };
}

export default defineEventHandler(async (event) => {
  logger.debug('GET /api/books');

  // Keep consistent with the rest of the app: require an authenticated user
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return {
      success: false,
      message: 'Unauthorized',
    };
  }

  const userId = session.user.id;

  // Optional query params:
  // - collectionId=<id> fetches books only from that collection (if user is a member)
  // - omit collectionId to fetch books from all collections the user is a member of
  // - limit=<n> max page size (default 48)
  // - cursor=<opaque> pagination cursor (sort-dependent) for infinite scroll
  // - sort=<dateAdded|alphabetical|publishedDate> (default dateAdded)
  // - sortDir=<asc|desc> (default per sort; dateAdded desc)
  // - addedStart=<YYYY-MM-DD> optional (inclusive)
  // - addedEnd=<YYYY-MM-DD> optional (inclusive)
  // - status=<csv> optional (e.g. "reading,to_be_read,none")
  const q = getQuery(event) as {
    collectionId?: string;
    limit?: string;
    cursor?: string;
    sort?: string;
    sortDir?: string;
    addedStart?: string;
    addedEnd?: string;
    status?: string;
    debug?: string;
  };

  const collectionId = q.collectionId;
  // Allow smaller page sizes for dev/testing (small libraries, observer/manual pagination verification).
  const limit = clampInt(q.limit, { min: 1, max: 200, fallback: 48 });

  const sort = normalizeSortKey(q.sort);
  const sortDir = normalizeSortDir(q.sortDir, sort);

  const cursor = decodeCursor(q.cursor);
  const statusFilter = normalizeStatusFilter(q.status);

  // Added date range filter (books.createdAt)
  // Inputs are expected as YYYY-MM-DD from <input type="date">.
  //
  // IMPORTANT: In this app `books.createdAt` is stored as a unix timestamp in *seconds*.
  // To make filtering reliable, we convert the incoming dates to *integer second* bounds and
  // compare numerically against `createdAt` (after coercing it to an INTEGER in SQL).
  //
  // Treat:
  // - start as inclusive at 00:00:00.000 local time
  // - end as inclusive through 23:59:59.999 local time
  const parseYmdLocal = (raw?: string) => {
    const v = (raw ?? '').toString().trim();
    if (!v) return null;

    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return null;

    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);

    if (
      !Number.isFinite(y) ||
      !Number.isFinite(mo) ||
      !Number.isFinite(d) ||
      mo < 1 ||
      mo > 12 ||
      d < 1 ||
      d > 31
    ) {
      return null;
    }

    const dt = new Date(y, mo - 1, d);
    if (!Number.isFinite(dt.getTime())) return null;
    return dt;
  };

  const addedStartDate = parseYmdLocal(q.addedStart);
  const addedEndDate = parseYmdLocal(q.addedEnd);

  const addedStartSec = addedStartDate
    ? Math.floor(
        new Date(
          addedStartDate.getFullYear(),
          addedStartDate.getMonth(),
          addedStartDate.getDate(),
          0,
          0,
          0,
          0,
        ).getTime() / 1000,
      )
    : null;

  const addedEndSec = addedEndDate
    ? Math.floor(
        new Date(
          addedEndDate.getFullYear(),
          addedEndDate.getMonth(),
          addedEndDate.getDate(),
          23,
          59,
          59,
          999,
        ).getTime() / 1000,
      )
    : null;

  const debug =
    q.debug === '1' ||
    q.debug === 'true' ||
    q.debug === 'yes' ||
    q.debug === 'on';

  if (debug) {
    logger.info(
      {
        addedStartRaw: q.addedStart ?? null,
        addedEndRaw: q.addedEnd ?? null,
        addedStartParsed: addedStartDate ? addedStartDate.toString() : null,
        addedEndParsed: addedEndDate ? addedEndDate.toString() : null,
        addedStartSec,
        addedEndSec,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      },
      'GET /api/books: added date filter parsed',
    );
  }

  try {
    // Backfill normalized publishedAt once per process start (best-effort).
    // This keeps sorting correct for older rows that only have `published` populated.
    // NOTE: This is intentionally lightweight; if you want a proper migration/backfill,
    // move this into a dedicated admin task or migration step.
    try {
      await cloudDb.run(sql`
        UPDATE books
        SET published_at =
          CASE
            WHEN published_at IS NOT NULL THEN published_at
            WHEN published IS NULL OR TRIM(published) = '' THEN NULL
            -- YYYY-MM-DD
            WHEN published GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' THEN strftime('%s', published) * 1000
            -- YYYY-MM
            WHEN published GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' THEN strftime('%s', published || '-01') * 1000
            -- YYYY
            WHEN published GLOB '[0-9][0-9][0-9][0-9]' THEN strftime('%s', published || '-01-01') * 1000
            ELSE NULL
          END
        WHERE published_at IS NULL
          AND published IS NOT NULL
          AND TRIM(published) <> '';
      `);
    } catch (e) {
      logger.debug(e, 'GET /api/books: publishedAt backfill skipped/failed');
    }

    // Find collections the user is a member of
    const memberships = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, userId));

    const memberCollectionIds = Array.from(
      new Set(memberships.map((m) => m.collectionId)),
    ).filter(Boolean);

    if (!memberCollectionIds.length) {
      return {
        success: true,
        data: {
          books: [],
          nextCursor: null,
        },
      };
    }

    // Determine which collections to use for the query
    const targetCollectionIds = collectionId
      ? memberCollectionIds.includes(collectionId)
        ? [collectionId]
        : []
      : memberCollectionIds;

    // If a specific collection was requested but the user isn't a member, return empty
    // (avoid leaking existence of collections).
    if (!targetCollectionIds.length) {
      return {
        success: true,
        data: {
          books: [],
          nextCursor: null,
        },
      };
    }

    // Build cursor conditions + orderBy based on sort mode.
    // NOTE: For title/published sorts we still filter the visible book set via collection_books,
    // but sorting uses the books table fields.
    const orderPrimary: SQLWrapper =
      sort === 'dateAdded'
        ? books.createdAt
        : sort === 'alphabetical'
          ? books.sortTitle
          : sql`COALESCE(${books.publishedAt}, 0)`;

    const orderPrimaryDesc = sortDir === 'desc';

    // Cursor predicate:
    // - Use lexicographic compare for sortTitle/published (both are TEXT)
    // - Use date compare for createdAt (timestamp)
    const cursorWhere =
      cursor && sort === 'dateAdded'
        ? sortDir === 'asc'
          ? or(
              gt(books.createdAt, new Date(cursor.v)),
              and(
                eq(books.createdAt, new Date(cursor.v)),
                gt(books.id, cursor.id),
              ),
            )
          : or(
              lt(books.createdAt, new Date(cursor.v)),
              and(
                eq(books.createdAt, new Date(cursor.v)),
                lt(books.id, cursor.id),
              ),
            )
        : cursor && sort === 'alphabetical'
          ? sortDir === 'asc'
            ? or(
                gt(books.sortTitle, cursor.v),
                and(eq(books.sortTitle, cursor.v), gt(books.id, cursor.id)),
              )
            : or(
                lt(books.sortTitle, cursor.v),
                and(eq(books.sortTitle, cursor.v), lt(books.id, cursor.id)),
              )
          : cursor && sort === 'publishedDate'
            ? (() => {
                const cursorMs = Number.parseInt(cursor.v, 10);
                const v = Number.isFinite(cursorMs) ? cursorMs : 0;

                return sortDir === 'asc'
                  ? or(
                      gt(sql`COALESCE(${books.publishedAt}, 0)`, v),
                      and(
                        eq(sql`COALESCE(${books.publishedAt}, 0)`, v),
                        gt(books.id, cursor.id),
                      ),
                    )
                  : or(
                      lt(sql`COALESCE(${books.publishedAt}, 0)`, v),
                      and(
                        eq(sql`COALESCE(${books.publishedAt}, 0)`, v),
                        lt(books.id, cursor.id),
                      ),
                    );
              })()
            : undefined;

    // Page query: fetch visible books via the collection link table.
    // Sort is selectable, with deterministic tie-break by id.
    let baseQuery = cloudDb
      .select({ book: books })
      .from(books)
      .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id));

    const commonWhere = and(
      inArray(collectionBooks.collectionId, targetCollectionIds),
      cursorWhere,
      // Inclusive range (numeric compare against unix-second bounds)
      // We coerce createdAt to INTEGER to handle cases where it may be stored as TEXT.
      addedStartSec !== null
        ? sql`CAST(${books.createdAt} AS INTEGER) >= ${addedStartSec}`
        : undefined,
      addedEndSec !== null
        ? sql`CAST(${books.createdAt} AS INTEGER) <= ${addedEndSec}`
        : undefined,
    );

    const hasStatusFilter =
      statusFilter.includeNone || statusFilter.statuses.length > 0;

    const statusWhere = hasStatusFilter
      ? statusFilter.includeNone && statusFilter.statuses.length
        ? or(
            inArray(userBookStatus.status, statusFilter.statuses),
            sql`${userBookStatus.status} IS NULL`,
          )
        : statusFilter.includeNone
          ? sql`${userBookStatus.status} IS NULL`
          : inArray(userBookStatus.status, statusFilter.statuses)
      : undefined;

    if (hasStatusFilter) {
      baseQuery = baseQuery.leftJoin(
        userBookStatus,
        and(
          eq(userBookStatus.bookId, books.id),
          eq(userBookStatus.userId, userId),
        ),
      );
    }

    const pageRows = await baseQuery
      .where(and(commonWhere, statusWhere))
      // Avoid duplicates if a book is in multiple target collections.
      // Group by book id provides a deterministic unique set in SQLite.
      .groupBy(books.id)
      .orderBy(
        orderPrimaryDesc ? desc(orderPrimary) : asc(orderPrimary),
        // Deterministic tie-break; keep direction aligned so paging is stable
        orderPrimaryDesc ? desc(books.id) : asc(books.id),
      )
      .limit(limit + 1);

    if (debug) {
      const sample = pageRows
        .slice(0, 5)
        .map((r) =>
          r?.book ? { id: r.book.id, createdAt: r.book.createdAt } : r,
        );

      logger.info(
        {
          returnedRows: pageRows.length,
          limit,
          cursor: q.cursor ?? null,
          sort,
          sortDir,
          filter: { addedStartSec, addedEndSec },
          sampleCreatedAt: sample,
        },
        'GET /api/books: query results sample (createdAt)',
      );

      // Additionally log count of books that would match the date filter alone (within the same collection scope)
      try {
        const countRows = await cloudDb
          .select({ n: sql<number>`COUNT(*)` })
          .from(books)
          .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
          .where(
            and(
              inArray(collectionBooks.collectionId, targetCollectionIds),
              addedStartSec !== null
                ? sql`CAST(${books.createdAt} AS INTEGER) >= ${addedStartSec}`
                : undefined,
              addedEndSec !== null
                ? sql`CAST(${books.createdAt} AS INTEGER) <= ${addedEndSec}`
                : undefined,
            ),
          );

        logger.info(
          { matchingCount: countRows?.[0]?.n ?? null },
          'GET /api/books: count matching date filter within scope',
        );
      } catch (e) {
        logger.info(e, 'GET /api/books: debug count query failed');
      }
    }

    const rows = pageRows
      .map((r) => r.book)
      .filter((b): b is NonNullable<(typeof books)['$inferSelect']> => !!b);

    const bookIds = rows.map((b) => b.id).filter(Boolean);

    if (!bookIds.length) {
      return {
        success: true,
        data: {
          books: [],
          nextCursor: null,
        },
      };
    }

    // Attach author display info (multi-author):
    // - return `authorNames` (string[]) and `authors` ({id,name}[])
    // - keep legacy `author` as the first/primary author for back-compat
    const authorLinks = await cloudDb
      .select({
        bookId: bookAuthors.bookId,
        authorId: bookAuthors.authorId,
        position: bookAuthors.position,
      })
      .from(bookAuthors)
      .where(inArray(bookAuthors.bookId, bookIds));

    const authorIds = Array.from(
      new Set(authorLinks.map((l) => l.authorId)),
    ).filter(Boolean);

    const authorRows = authorIds.length
      ? await cloudDb
          .select({ id: authors.id, name: authors.name })
          .from(authors)
          .where(inArray(authors.id, authorIds))
      : [];

    const authorNameById = new Map(authorRows.map((a) => [a.id, a.name]));

    const linksByBookId = new Map<string, typeof authorLinks>();
    for (const link of authorLinks) {
      const list = linksByBookId.get(link.bookId) ?? [];
      list.push(link);
      linksByBookId.set(link.bookId, list);
    }

    // Attach publisher + series display info:
    // - return `publisher`/`series` as `{id,name}` for list views
    // - also keep `publisherId`/`seriesId` for compatibility
    const publisherIds = Array.from(
      new Set(rows.map((b) => b.publisherId).filter(Boolean)),
    ) as string[];

    const seriesIds = Array.from(
      new Set(rows.map((b) => b.seriesId).filter(Boolean)),
    ) as string[];

    const publisherRows = publisherIds.length
      ? await cloudDb
          .select({ id: publishers.id, name: publishers.name })
          .from(publishers)
          .where(inArray(publishers.id, publisherIds))
      : [];

    const seriesRows = seriesIds.length
      ? await cloudDb
          .select({ id: series.id, name: series.name })
          .from(series)
          .where(inArray(series.id, seriesIds))
      : [];

    const publisherById = new Map(publisherRows.map((p) => [p.id, p]));
    const seriesById = new Map(seriesRows.map((s) => [s.id, s]));

    const rowsWithAuthor = rows.map((b) => {
      const links = (linksByBookId.get(b.id) ?? []).slice();
      links.sort((a, c) => {
        const aPos = typeof a.position === 'number' ? a.position : 10_000;
        const cPos = typeof c.position === 'number' ? c.position : 10_000;
        return aPos - cPos;
      });

      const authorNames = links
        .map((l) => (l.authorId ? authorNameById.get(l.authorId) : undefined))
        .filter((n): n is string => typeof n === 'string' && n.length > 0);

      const authorsOut = links
        .map((l) => {
          const name = l.authorId ? authorNameById.get(l.authorId) : undefined;
          if (!l.authorId || !name) return null;
          return { id: l.authorId, name };
        })
        .filter(
          (a): a is { id: string; name: string } =>
            !!a && typeof a.id === 'string' && typeof a.name === 'string',
        );

      // Back-compat: keep the first author in `author`
      const author = authorNames[0];

      const publisher = b.publisherId
        ? (publisherById.get(b.publisherId) ?? null)
        : null;

      const seriesOut = b.seriesId
        ? (seriesById.get(b.seriesId) ?? null)
        : null;

      return {
        ...b,
        author,
        authorNames,
        authors: authorsOut,
        publisher,
        series: seriesOut,
      };
    });

    // Only return a nextCursor when there are more books beyond this page.
    // We do this by fetching limit+1 rows and using the extra row as "hasMore",
    // while returning only `limit` rows to the client.
    const hasMore = rowsWithAuthor.length > limit;
    const page = hasMore ? rowsWithAuthor.slice(0, limit) : rowsWithAuthor;

    const last = page[page.length - 1];

    const nextCursor =
      hasMore && last?.id
        ? encodeCursor({
            v:
              sort === 'dateAdded'
                ? new Date(last.createdAt).toISOString()
                : sort === 'alphabetical'
                  ? (last.sortTitle ?? '')
                  : String(
                      Number.isFinite(
                        Number(
                          last.publishedAt instanceof Date
                            ? last.publishedAt.getTime()
                            : typeof last.publishedAt === 'number'
                              ? last.publishedAt
                              : 0,
                        ),
                      )
                        ? Number(
                            last.publishedAt instanceof Date
                              ? last.publishedAt.getTime()
                              : typeof last.publishedAt === 'number'
                                ? last.publishedAt
                                : 0,
                          )
                        : 0,
                    ),
            id: last.id,
          })
        : null;

    return {
      success: true,
      data: {
        books: page,
        nextCursor,
      },
    };
  } catch (error) {
    logger.error(error, 'GET /api/books: Error fetching books');
    setResponseStatus(event, 500);
    return {
      success: false,
      message: 'Failed to fetch books',
    };
  }
});
