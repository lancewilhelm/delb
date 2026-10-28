import { and, eq, inArray } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookProgressLog,
  userBookStatus,
  USER_BOOK_STATUSES,
} from '~/utils/db/schema';

type Status = (typeof USER_BOOK_STATUSES)[number];
type Change = {
  status?: Status | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  dnfAt?: Date | null;
  tbrRank?: number | null;
};
type ResultRow = {
  bookId: string;
  status: Status | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  dnfAt: Date | null;
  tbrRank: number | null;
};

export async function transitionBookStatuses({
  userId,
  bookIds,
  change,
  now,
}: {
  userId: string;
  bookIds: string[];
  change: Change;
  now: Date;
}) {
  return cloudDb.transaction(async (tx) => {
    const visible = await tx
      .selectDistinct({ id: books.id, pages: books.pages })
      .from(books)
      .innerJoin(collectionBooks, eq(collectionBooks.bookId, books.id))
      .innerJoin(
        collectionMembers,
        eq(collectionMembers.collectionId, collectionBooks.collectionId),
      )
      .where(
        and(inArray(books.id, bookIds), eq(collectionMembers.userId, userId)),
      );
    const visibleById = new Map(visible.map((book) => [book.id, book]));
    const orderedIds = bookIds.filter((id) => visibleById.has(id));
    const existing = await tx
      .select()
      .from(userBookStatus)
      .where(eq(userBookStatus.userId, userId));
    const rows = new Map(existing.map((row) => [row.bookId, row]));
    const tbr = existing
      .filter((row) => row.status === 'to_be_read')
      .sort(
        (a, b) =>
          (a.tbrRank ?? Number.MAX_SAFE_INTEGER) -
            (b.tbrRank ?? Number.MAX_SAFE_INTEGER) ||
          a.bookId.localeCompare(b.bookId),
      )
      .map((row) => row.bookId);
    const results: ResultRow[] = [];
    let cleared = 0;
    for (const bookId of orderedIds) {
      const old = rows.get(bookId);
      const oldStatus =
        old?.status &&
        (USER_BOOK_STATUSES as readonly string[]).includes(old.status)
          ? (old.status as Status)
          : null;
      let status: Status | null =
        change.status !== undefined ? change.status : oldStatus;
      let startedAt =
        change.startedAt !== undefined
          ? change.startedAt
          : (old?.startedAt ?? null);
      let finishedAt =
        change.finishedAt !== undefined
          ? change.finishedAt
          : (old?.finishedAt ?? null);
      let dnfAt =
        change.dnfAt !== undefined ? change.dnfAt : (old?.dnfAt ?? null);
      if (change.status === undefined) {
        if (change.finishedAt) status = 'finished';
        else if (change.dnfAt) status = 'dnf';
        else if (
          change.startedAt &&
          (oldStatus === null ||
            oldStatus === 'to_be_read' ||
            oldStatus === 'reading')
        )
          status = 'reading';
        else if (change.finishedAt === null && oldStatus === 'finished')
          status = startedAt ? 'reading' : 'to_be_read';
        else if (change.dnfAt === null && oldStatus === 'dnf')
          status = startedAt ? 'reading' : 'to_be_read';
      }
      const oldIndex = tbr.indexOf(bookId);
      if (oldIndex >= 0) tbr.splice(oldIndex, 1);
      if (status === null) {
        if (
          change.startedAt ||
          change.finishedAt ||
          change.dnfAt ||
          (change.tbrRank !== undefined && change.tbrRank !== null)
        )
          throw createError({
            statusCode: 400,
            statusMessage: 'Cannot set status metadata when clearing status.',
          });
        const deleted = await tx
          .delete(userBookStatus)
          .where(
            and(
              eq(userBookStatus.userId, userId),
              eq(userBookStatus.bookId, bookId),
            ),
          )
          .returning({ bookId: userBookStatus.bookId });
        cleared += deleted.length;
        results.push({
          bookId,
          status: null,
          startedAt: null,
          finishedAt: null,
          dnfAt: null,
          tbrRank: null,
        });
        continue;
      }
      if (change.tbrRank !== undefined && status !== 'to_be_read')
        throw createError({
          statusCode: 400,
          statusMessage: 'tbrRank can only be set when status is to_be_read.',
        });
      if (status === 'reading') startedAt ??= now;
      if (status === 'finished') {
        finishedAt ??= now;
        startedAt ??= finishedAt;
      }
      if (status === 'dnf') {
        dnfAt ??= now;
        startedAt ??= dnfAt;
      }
      if (status !== 'finished') finishedAt = null;
      if (status !== 'dnf') dnfAt = null;
      if (status === 'to_be_read') {
        startedAt = null;
        finishedAt = null;
        dnfAt = null;
      }
      if (startedAt && finishedAt && finishedAt < startedAt)
        throw createError({
          statusCode: 400,
          statusMessage: 'finishedAt must be on or after startedAt.',
        });
      if (startedAt && dnfAt && dnfAt < startedAt)
        throw createError({
          statusCode: 400,
          statusMessage: 'dnfAt must be on or after startedAt.',
        });
      if (status === 'to_be_read') {
        const index =
          change.tbrRank != null
            ? Math.min(change.tbrRank - 1, tbr.length)
            : oldIndex >= 0
              ? Math.min(oldIndex, tbr.length)
              : tbr.length;
        tbr.splice(index, 0, bookId);
      }
      const values = {
        status,
        startedAt,
        finishedAt,
        dnfAt,
        tbrRank: null,
        updatedAt: now,
      };
      await tx
        .insert(userBookStatus)
        .values({ userId, bookId, ...values })
        .onConflictDoUpdate({
          target: [userBookStatus.userId, userBookStatus.bookId],
          set: values,
        });
      results.push({
        bookId,
        status,
        startedAt,
        finishedAt,
        dnfAt,
        tbrRank: null,
      });
      if (status === 'finished' && finishedAt) {
        const logs = await tx
          .select({ id: userBookProgressLog.id })
          .from(userBookProgressLog)
          .where(
            and(
              eq(userBookProgressLog.userId, userId),
              eq(userBookProgressLog.bookId, bookId),
              eq(userBookProgressLog.source, 'status-finished'),
            ),
          )
          .limit(1);
        const values = {
          progressPercent: 100,
          pageNumber: visibleById.get(bookId)?.pages ?? null,
          occurredAt: finishedAt,
        };
        if (logs[0])
          await tx
            .update(userBookProgressLog)
            .set(values)
            .where(eq(userBookProgressLog.id, logs[0].id));
        else
          await tx
            .insert(userBookProgressLog)
            .values({
              id: crypto.randomUUID(),
              userId,
              bookId,
              location: null,
              source: 'status-finished',
              createdAt: now,
              ...values,
            });
      }
    }
    for (let i = 0; i < tbr.length; i++) {
      await tx
        .update(userBookStatus)
        .set({ tbrRank: i + 1 })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            eq(userBookStatus.bookId, tbr[i]!),
          ),
        );
    }
    for (const row of results)
      if (row.status === 'to_be_read')
        row.tbrRank = tbr.indexOf(row.bookId) + 1;
    return {
      rows: results,
      visible: orderedIds.length,
      updated:
        change.status === null
          ? 0
          : results.filter((row) => row.status !== null).length,
      cleared,
    };
  });
}
