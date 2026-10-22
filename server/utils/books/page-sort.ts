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

/** Numeric page ordering, with unknown counts last in either direction.
 * Zero is valid under the book editor/API contract. Invalid legacy/provider
 * values are treated as unknown for sorting only; no metadata is changed.
 */
export function pageSort(
  pages: SQLWrapper,
  id: SQLWrapper,
  direction: 'asc' | 'desc',
  cursor: { v: string; id: string } | null,
) {
  const value = sql`CASE WHEN typeof(${pages}) = 'integer' AND ${pages} >= 0 THEN ${pages} ELSE NULL END`;
  const unknown = sql`(${value} IS NULL)`;
  const compare = direction === 'asc' ? gt : lt;
  const order = direction === 'asc' ? asc : desc;
  const cursorNumber = cursor?.v ? Number(cursor.v) : NaN;
  const knownCursor = Number.isInteger(cursorNumber) && cursorNumber >= 0;

  return {
    orderBy: [asc(unknown), order(value), order(id)],
    where: !cursor
      ? undefined
      : knownCursor
        ? or(
            eq(unknown, 1),
            compare(value, cursorNumber),
            and(eq(value, cursorNumber), compare(id, cursor.id)),
          )
        : and(eq(unknown, 1), compare(id, cursor.id)),
    cursorValue: (count: number | null) =>
      typeof count === 'number' && Number.isInteger(count) && count >= 0
        ? String(count)
        : '',
  };
}
