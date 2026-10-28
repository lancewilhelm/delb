import { USER_BOOK_STATUSES } from '~/utils/db/schema';
import { transitionBookStatuses } from '~~/server/utils/books/status-transition';
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

function parseDateField(
  body: StatusBody | null,
  key: keyof StatusBody,
): ParsedDateField {
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
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
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
    const result = await transitionBookStatuses({
      userId,
      bookIds: [bookId],
      now: new Date(),
      change: {
        status: statusInput,
        startedAt: startedAtField.provided
          ? (startedAtField.value ?? null)
          : undefined,
        finishedAt: finishedAtField.provided
          ? (finishedAtField.value ?? null)
          : undefined,
        dnfAt: dnfAtField.provided ? (dnfAtField.value ?? null) : undefined,
        tbrRank: tbrRankInput,
      },
    });
    const row = result.rows[0];
    if (!row) {
      setResponseStatus(event, 404);
      return { success: false, message: 'Book not found' };
    }
    return {
      success: true,
      data: {
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        dnfAt: row.dnfAt,
        tbrRank: row.tbrRank,
      },
    };
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error)
      throw error;
    logger.error(error, 'POST /api/books/:id/status: Error setting status');
    setResponseStatus(event, 500);
    return { success: false, message: 'Failed to set status' };
  }
});
