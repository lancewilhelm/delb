import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  sql,
} from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import {
  books,
  collectionBooks,
  collectionMembers,
  userBookProgressLog,
  userBookStatus,
  USER_BOOK_STATUSES,
} from '~/utils/db/schema';
import { logger } from '~/utils/logger';
import { auth } from '~/utils/auth';

type StatusBody = {
  status?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  dnfAt?: unknown;
  tbrRank?: unknown;
};

type ParsedDateField = {
  provided: boolean;
  value?: Date | null;
  error?: string;
};

function parseDateField(body: StatusBody | null, key: keyof StatusBody): ParsedDateField {
  if (!body || !(key in body)) return { provided: false };
  const raw = body[key];
  if (raw === null || raw === '') return { provided: true, value: null };
  if (raw instanceof Date) {
    if (!Number.isNaN(raw.getTime())) return { provided: true, value: raw };
    return { provided: true, error: 'Invalid date' };
  }
  if (typeof raw === 'number') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return { provided: true, value: d };
    return { provided: true, error: 'Invalid date' };
  }
  if (typeof raw === 'string') {
    const v = raw.trim();
    if (!v) return { provided: true, value: null };
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (!Number.isNaN(d.getTime())) return { provided: true, value: d };
    }
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return { provided: true, value: d };
  }
  return { provided: true, error: 'Invalid date' };
}

/**
 * POST /api/books/:id/status
 *
 * Sets (or clears) the authenticated user's status for a book.
 *
 * Status is mutually exclusive per (user, book).
 *
 * Body:
 * - {
 *     status?: "to_be_read" | "reading" | "finished" | "dnf" | null,
 *     startedAt?: string | number | null,
 *     finishedAt?: string | number | null,
 *     dnfAt?: string | number | null,
 *     tbrRank?: number | null,
 *   }
 *
 * Clearing:
 * - send `null` (or omit `status`) to clear/delete the status
 *
 * Guardrails:
 * - Requires authenticated user
 * - Uses the same visibility model as GET /api/books/:id:
 *   the user must be a member of at least one collection that contains the book.
 *
 * Response:
 * - {
 *     success: true,
 *     data: {
 *       status: string | null,
 *       startedAt: string | null,
 *       finishedAt: string | null,
 *       dnfAt: string | null,
 *       tbrRank: number | null,
 *     }
 *   }
 */
export default defineEventHandler(async (event) => {
  logger.debug('POST /api/books/:id/status');

  const session = await auth.api.getSession({ headers: event.headers });
  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const userId = session.user.id;

  const bookId = getRouterParam(event, 'id');
  if (!bookId) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Missing book id' };
  }

  const body = (await readBody(event).catch(() => null)) as StatusBody | null;

  const statusProvided =
    Boolean(body) && Object.prototype.hasOwnProperty.call(body, 'status');
  const rawStatus = statusProvided ? body?.status : undefined;

  let statusInput: (typeof USER_BOOK_STATUSES)[number] | null | undefined =
    undefined;

  if (statusProvided) {
    // Clear if null/undefined/empty string
    const wantsClear =
      rawStatus === null || rawStatus === undefined || rawStatus === '';

    if (wantsClear) {
      statusInput = null;
    } else {
      if (typeof rawStatus !== 'string') {
        setResponseStatus(event, 400);
        return {
          success: false,
          message: 'Invalid status (must be a string or null to clear).',
        };
      }

      // Keep it strict for now: only built-in statuses.
      if (!(USER_BOOK_STATUSES as readonly string[]).includes(rawStatus)) {
        setResponseStatus(event, 400);
        return {
          success: false,
          message: `Invalid status. Expected one of: ${USER_BOOK_STATUSES.join(
            ', ',
          )}`,
        };
      }

      statusInput = rawStatus as (typeof USER_BOOK_STATUSES)[number];
    }
  }

  const startedAtField = parseDateField(body, 'startedAt');
  if (startedAtField.error) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Invalid startedAt date.' };
  }

  const finishedAtField = parseDateField(body, 'finishedAt');
  if (finishedAtField.error) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Invalid finishedAt date.' };
  }

  const dnfAtField = parseDateField(body, 'dnfAt');
  if (dnfAtField.error) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Invalid dnfAt date.' };
  }

  let tbrRankInput: number | null | undefined = undefined;
  if (body && Object.prototype.hasOwnProperty.call(body, 'tbrRank')) {
    const rawRank = body.tbrRank;
    if (rawRank === null || rawRank === '') {
      tbrRankInput = null;
    } else {
      const parsed =
        typeof rawRank === 'number'
          ? rawRank
          : typeof rawRank === 'string'
            ? Number(rawRank)
            : NaN;
      if (
        !Number.isFinite(parsed) ||
        !Number.isInteger(parsed) ||
        parsed < 1
      ) {
        setResponseStatus(event, 400);
        return {
          success: false,
          message: 'Invalid tbrRank value (must be a whole number >= 1).',
        };
      }
      tbrRankInput = parsed;
    }
  }

  try {
    // Enforce visibility:
    // user must be a member of at least one collection containing this book.
    const memberships = await cloudDb
      .select({ collectionId: collectionMembers.collectionId })
      .from(collectionMembers)
      .where(eq(collectionMembers.userId, userId));

    const memberCollectionIds = Array.from(
      new Set(memberships.map((m) => m.collectionId)),
    ).filter(Boolean);

    if (!memberCollectionIds.length) {
      setResponseStatus(event, 404);
      return { success: false, message: 'Book not found' };
    }

    const visible = await cloudDb
      .select({ id: books.id, pages: books.pages })
      .from(books)
      .innerJoin(
        collectionBooks,
        and(eq(collectionBooks.bookId, books.id), eq(books.id, bookId)),
      )
      .where(inArray(collectionBooks.collectionId, memberCollectionIds))
      .limit(1);

    if (!visible[0]) {
      setResponseStatus(event, 404);
      return { success: false, message: 'Book not found' };
    }

    const bookPages = visible[0]?.pages ?? null;

    const existingRow =
      (
        await cloudDb
          .select({
            status: userBookStatus.status,
            startedAt: userBookStatus.startedAt,
            finishedAt: userBookStatus.finishedAt,
            dnfAt: userBookStatus.dnfAt,
            tbrRank: userBookStatus.tbrRank,
          })
          .from(userBookStatus)
          .where(
            and(
              eq(userBookStatus.userId, userId),
              eq(userBookStatus.bookId, bookId),
            ),
          )
          .limit(1)
      )[0] ?? null;

    const existingStatusRaw = existingRow?.status ?? null;
    const existingStatus =
      existingStatusRaw &&
      (USER_BOOK_STATUSES as readonly string[]).includes(existingStatusRaw)
        ? (existingStatusRaw as (typeof USER_BOOK_STATUSES)[number])
        : null;

    let nextStatus: (typeof USER_BOOK_STATUSES)[number] | null = existingStatus;
    let nextStartedAt = existingRow?.startedAt ?? null;
    let nextFinishedAt = existingRow?.finishedAt ?? null;
    let nextDnfAt = existingRow?.dnfAt ?? null;
    let nextTbrRank = existingRow?.tbrRank ?? null;

    if (startedAtField.provided) {
      nextStartedAt = startedAtField.value ?? null;
    }
    if (finishedAtField.provided) {
      nextFinishedAt = finishedAtField.value ?? null;
    }
    if (dnfAtField.provided) {
      nextDnfAt = dnfAtField.value ?? null;
    }
    if (tbrRankInput !== undefined) {
      nextTbrRank = tbrRankInput;
    }

    if (statusInput !== undefined) {
      nextStatus = statusInput;
    } else if (finishedAtField.provided && finishedAtField.value) {
      nextStatus = 'finished';
    } else if (dnfAtField.provided && dnfAtField.value) {
      nextStatus = 'dnf';
    } else if (startedAtField.provided && startedAtField.value) {
      if (
        existingStatus === null ||
        existingStatus === 'to_be_read' ||
        existingStatus === 'reading'
      ) {
        nextStatus = 'reading';
      }
    } else if (
      finishedAtField.provided &&
      finishedAtField.value === null &&
      existingStatus === 'finished'
    ) {
      nextStatus = nextStartedAt ? 'reading' : 'to_be_read';
    } else if (
      dnfAtField.provided &&
      dnfAtField.value === null &&
      existingStatus === 'dnf'
    ) {
      nextStatus = nextStartedAt ? 'reading' : 'to_be_read';
    }

    if (nextStatus === null) {
      const hasNonNullDate =
        (startedAtField.provided && startedAtField.value) ||
        (finishedAtField.provided && finishedAtField.value) ||
        (dnfAtField.provided && dnfAtField.value);

      if (
        hasNonNullDate ||
        (tbrRankInput !== undefined && tbrRankInput !== null)
      ) {
        setResponseStatus(event, 400);
        return {
          success: false,
          message: 'Cannot set status metadata when clearing status.',
        };
      }

      await cloudDb
        .delete(userBookStatus)
        .where(
          and(
            eq(userBookStatus.userId, userId),
            eq(userBookStatus.bookId, bookId),
          ),
        );

      return {
        success: true,
        data: {
          status: null,
          startedAt: null,
          finishedAt: null,
          dnfAt: null,
          tbrRank: null,
        },
      };
    }

    if (tbrRankInput !== undefined && nextStatus !== 'to_be_read') {
      setResponseStatus(event, 400);
      return {
        success: false,
        message: 'tbrRank can only be set when status is to_be_read.',
      };
    }

    const now = new Date();

    if (nextStatus === 'reading') {
      if (!nextStartedAt) nextStartedAt = now;
    }

    if (nextStatus === 'finished') {
      if (!nextFinishedAt) nextFinishedAt = now;
      if (!nextStartedAt && nextFinishedAt) {
        nextStartedAt = nextFinishedAt;
      }
    }

    if (nextStatus === 'dnf') {
      if (!nextDnfAt) nextDnfAt = now;
      if (!nextStartedAt && nextDnfAt) {
        nextStartedAt = nextDnfAt;
      }
    }

    if (nextStatus !== 'finished') {
      nextFinishedAt = null;
    }

    if (nextStatus !== 'dnf') {
      nextDnfAt = null;
    }

    if (nextStatus === 'to_be_read') {
      nextStartedAt = null;
      nextFinishedAt = null;
      nextDnfAt = null;
    }

    if (
      nextStartedAt &&
      nextFinishedAt &&
      nextFinishedAt.getTime() < nextStartedAt.getTime()
    ) {
      setResponseStatus(event, 400);
      return {
        success: false,
        message: 'finishedAt must be on or after startedAt.',
      };
    }

    if (
      nextStartedAt &&
      nextDnfAt &&
      nextDnfAt.getTime() < nextStartedAt.getTime()
    ) {
      setResponseStatus(event, 400);
      return {
        success: false,
        message: 'dnfAt must be on or after startedAt.',
      };
    }

    const updatedAt = new Date();
    const oldRank =
      existingStatus === 'to_be_read' ? existingRow?.tbrRank ?? null : null;
    let finalTbrRank = nextTbrRank;

    await cloudDb.transaction(async (tx) => {
      const countRow = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(userBookStatus)
        .where(
          and(
            eq(userBookStatus.userId, userId),
            eq(userBookStatus.status, 'to_be_read'),
          ),
        );

      const totalCount = Number(countRow[0]?.count ?? 0);
      const countOther =
        existingStatus === 'to_be_read' ? Math.max(0, totalCount - 1) : totalCount;
      const maxRank = countOther + 1;

      if (nextStatus !== 'to_be_read') {
        finalTbrRank = null;
        if (oldRank !== null) {
          await tx
            .update(userBookStatus)
            .set({ tbrRank: sql`${userBookStatus.tbrRank} - 1` })
            .where(
              and(
                eq(userBookStatus.userId, userId),
                eq(userBookStatus.status, 'to_be_read'),
                isNotNull(userBookStatus.tbrRank),
                gt(userBookStatus.tbrRank, oldRank),
                ne(userBookStatus.bookId, bookId),
              ),
            );
        }
      } else {
        let desiredRank: number | null = null;
        if (tbrRankInput !== undefined) {
          if (tbrRankInput === null) {
            desiredRank = null;
          } else {
            desiredRank = Math.min(Math.max(tbrRankInput, 1), maxRank);
          }
        } else if (oldRank !== null) {
          desiredRank = oldRank;
        } else {
          desiredRank = maxRank;
        }

        finalTbrRank = desiredRank;

        if (desiredRank === null) {
          if (oldRank !== null) {
            await tx
              .update(userBookStatus)
              .set({ tbrRank: sql`${userBookStatus.tbrRank} - 1` })
              .where(
                and(
                  eq(userBookStatus.userId, userId),
                  eq(userBookStatus.status, 'to_be_read'),
                  isNotNull(userBookStatus.tbrRank),
                  gt(userBookStatus.tbrRank, oldRank),
                  ne(userBookStatus.bookId, bookId),
                ),
              );
          }
        } else if (oldRank !== null) {
          if (desiredRank < oldRank) {
            await tx
              .update(userBookStatus)
              .set({ tbrRank: sql`${userBookStatus.tbrRank} + 1` })
              .where(
                and(
                  eq(userBookStatus.userId, userId),
                  eq(userBookStatus.status, 'to_be_read'),
                  isNotNull(userBookStatus.tbrRank),
                  gte(userBookStatus.tbrRank, desiredRank),
                  lt(userBookStatus.tbrRank, oldRank),
                  ne(userBookStatus.bookId, bookId),
                ),
              );
          } else if (desiredRank > oldRank) {
            await tx
              .update(userBookStatus)
              .set({ tbrRank: sql`${userBookStatus.tbrRank} - 1` })
              .where(
                and(
                  eq(userBookStatus.userId, userId),
                  eq(userBookStatus.status, 'to_be_read'),
                  isNotNull(userBookStatus.tbrRank),
                  gt(userBookStatus.tbrRank, oldRank),
                  lte(userBookStatus.tbrRank, desiredRank),
                  ne(userBookStatus.bookId, bookId),
                ),
              );
          }
        } else {
          await tx
            .update(userBookStatus)
            .set({ tbrRank: sql`${userBookStatus.tbrRank} + 1` })
            .where(
              and(
                eq(userBookStatus.userId, userId),
                eq(userBookStatus.status, 'to_be_read'),
                isNotNull(userBookStatus.tbrRank),
                gte(userBookStatus.tbrRank, desiredRank),
                ne(userBookStatus.bookId, bookId),
              ),
            );
        }
      }

      // Upsert: try update first; if nothing updated, insert.
      const updateRes = await tx
        .update(userBookStatus)
        .set({
          status: nextStatus,
          startedAt: nextStartedAt,
          finishedAt: nextFinishedAt,
          dnfAt: nextDnfAt,
          tbrRank: finalTbrRank,
          updatedAt,
        })
        .where(
          and(
            eq(userBookStatus.userId, userId),
            eq(userBookStatus.bookId, bookId),
          ),
        );

      const rowsAffected =
        typeof updateRes === 'number'
          ? updateRes
          : ((updateRes as { rowsAffected?: number })?.rowsAffected ?? 0);

      if (!rowsAffected) {
        try {
          await tx.insert(userBookStatus).values({
            userId,
            bookId,
            status: nextStatus,
            startedAt: nextStartedAt,
            finishedAt: nextFinishedAt,
            dnfAt: nextDnfAt,
            tbrRank: finalTbrRank,
            updatedAt,
          });
        } catch (e: unknown) {
          const message =
            typeof e === 'object' && e !== null && 'message' in e
              ? String((e as { message?: unknown }).message ?? '')
              : '';
          if (message.toLowerCase().includes('unique')) {
            await tx
              .update(userBookStatus)
              .set({
                status: nextStatus,
                startedAt: nextStartedAt,
                finishedAt: nextFinishedAt,
                dnfAt: nextDnfAt,
                tbrRank: finalTbrRank,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(userBookStatus.userId, userId),
                  eq(userBookStatus.bookId, bookId),
                ),
              );
          } else {
            throw e;
          }
        }
      }
    });
    nextTbrRank = finalTbrRank;

    if (nextStatus === 'finished' && nextFinishedAt) {
      try {
        const existingFinishedLog =
          (
            await cloudDb
              .select({
                id: userBookProgressLog.id,
                progressPercent: userBookProgressLog.progressPercent,
                occurredAt: userBookProgressLog.occurredAt,
              })
              .from(userBookProgressLog)
              .where(
                and(
                  eq(userBookProgressLog.userId, userId),
                  eq(userBookProgressLog.bookId, bookId),
                  eq(userBookProgressLog.source, 'status-finished'),
                ),
              )
              .orderBy(desc(userBookProgressLog.occurredAt))
              .limit(1)
          )[0] ?? null;

        const pageNumber = bookPages ?? null;
        const shouldUpdate =
          existingFinishedLog &&
          (Math.abs(Number(existingFinishedLog.progressPercent) - 100) > 0.001 ||
            (existingFinishedLog.occurredAt &&
              existingFinishedLog.occurredAt.getTime() !==
                nextFinishedAt.getTime()));

        if (existingFinishedLog?.id) {
          if (shouldUpdate) {
            await cloudDb
              .update(userBookProgressLog)
              .set({
                progressPercent: 100,
                pageNumber,
                occurredAt: nextFinishedAt,
              })
              .where(eq(userBookProgressLog.id, existingFinishedLog.id));
          }
        } else {
          await cloudDb.insert(userBookProgressLog).values({
            id: crypto.randomUUID(),
            userId,
            bookId,
            progressPercent: 100,
            pageNumber,
            location: null,
            source: 'status-finished',
            occurredAt: nextFinishedAt,
            createdAt: new Date(),
          });
        }
      } catch (logError) {
        logger.error(
          logError,
          'POST /api/books/:id/status: Error logging finished progress',
        );
      }
    }

    return {
      success: true,
      data: {
        status: nextStatus,
        startedAt: nextStartedAt,
        finishedAt: nextFinishedAt,
        dnfAt: nextDnfAt,
        tbrRank: nextTbrRank,
      },
    };
  } catch (error: unknown) {
    logger.error(error, 'POST /api/books/:id/status: Error setting status');
    setResponseStatus(event, 500);
    return { success: false, message: 'Failed to set status' };
  }
});
