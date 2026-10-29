import {
  and,
  asc,
  desc,
  eq,
  gt,
  lt,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import { books } from '../../../app/utils/db/schema';
import { pageSort } from './page-sort';

export type SortKey = 'dateAdded' | 'alphabetical' | 'publishedDate' | 'pages';
export type SortDir = 'asc' | 'desc';

type Cursor = {
  /**
   * Cursor payload depends on sort key:
   * - dateAdded: createdAt + id
   * - alphabetical: sortTitle + id
   * - publishedDate: published + id
   * - pages: non-negative integer or empty string (unknown) + id
   */
  v: string;
  id: string;
};

export function normalizeSortKey(raw: unknown): SortKey {
  const v = (raw ?? '').toString().trim();
  if (v === 'alphabetical') return 'alphabetical';
  if (v === 'publishedDate') return 'publishedDate';
  if (v === 'pages') return 'pages';
  return 'dateAdded';
}

export function normalizeSortDir(raw: unknown, sort: SortKey): SortDir {
  const v = (raw ?? '').toString().trim().toLowerCase();
  if (v === 'asc') return 'asc';
  if (v === 'desc') return 'desc';

  if (sort === 'alphabetical' || sort === 'pages') return 'asc';
  return 'desc';
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('v' in parsed) ||
      !('id' in parsed) ||
      typeof parsed.v !== 'string' ||
      typeof parsed.id !== 'string' ||
      !parsed.id.trim()
    )
      return null;
    return { v: parsed.v, id: parsed.id.trim() };
  } catch {
    return null;
  }
}

export function bookSort(
  sort: SortKey,
  sortDir: SortDir,
  cursor: Cursor | null,
) {
  if (
    cursor &&
    ((sort === 'dateAdded' && !Number.isFinite(new Date(cursor.v).getTime())) ||
      (sort === 'publishedDate' &&
        (!cursor.v || !Number.isFinite(Number(cursor.v)))) ||
      (sort === 'pages' &&
        cursor.v !== '' &&
        (!Number.isInteger(Number(cursor.v)) || Number(cursor.v) < 0)))
  )
    cursor = null;
  const pagesSort = pageSort(books.pages, books.id, sortDir, cursor);
  const orderPrimary: SQLWrapper =
    sort === 'dateAdded'
      ? books.createdAt
      : sort === 'alphabetical'
        ? books.sortTitle
        : sql`COALESCE(${books.publishedAt}, 0)`;

  const orderPrimaryDesc = sortDir === 'desc';

  const cursorWhere =
    sort === 'pages'
      ? pagesSort.where
      : cursor && sort === 'dateAdded'
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
                const v = Number.isFinite(cursorMs)
                  ? Math.floor(cursorMs / 1000)
                  : 0;

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

  return {
    where: cursorWhere,
    orderBy:
      sort === 'pages'
        ? pagesSort.orderBy
        : [
            orderPrimaryDesc ? desc(orderPrimary) : asc(orderPrimary),
            orderPrimaryDesc ? desc(books.id) : asc(books.id),
          ],
  };
}

export function nextBookCursor(
  sort: SortKey,
  hasMore: boolean,
  last: typeof books.$inferSelect | undefined,
) {
  const pagesSort = pageSort(books.pages, books.id, 'asc', null);
  return hasMore && last?.id
    ? encodeCursor({
        v:
          sort === 'pages'
            ? pagesSort.cursorValue(last.pages)
            : sort === 'dateAdded'
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
}
