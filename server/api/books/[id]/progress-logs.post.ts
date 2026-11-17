import { cloudDb } from '~~/server/utils/db/cloud';
import {
  ProgressError,
  recordManualProgress,
} from '~~/server/utils/books/progress';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

type Body = {
  progressPercent?: unknown;
  pageNumber?: unknown;
  occurredAt?: unknown;
};

function parseDateInput(raw: unknown): Date | null | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? 'invalid' : raw;
  if (typeof raw === 'number') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? 'invalid' : d;
  }
  if (typeof raw === 'string') {
    const v = raw.trim();
    if (!v) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime()) ? 'invalid' : d;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? 'invalid' : d;
  }
  return 'invalid';
}

/**
 * POST /api/books/:id/progress-logs
 *
 * Adds a manual progress log entry.
 */
export default defineEventHandler(async (event) => {
  logger.debug('POST /api/books/:id/progress-logs');

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

  const body = (await readBody<Body>(event).catch(() => null)) ?? {};

  const rawPercent = body.progressPercent;
  const rawPage = body.pageNumber;

  let progressPercent: number | null = null;
  if (rawPercent !== undefined && rawPercent !== null && rawPercent !== '') {
    const parsed =
      typeof rawPercent === 'number'
        ? rawPercent
        : typeof rawPercent === 'string'
          ? Number(rawPercent)
          : NaN;
    if (!Number.isFinite(parsed)) {
      setResponseStatus(event, 400);
      return { success: false, message: 'Invalid progressPercent value.' };
    }
    if (parsed < 0 || parsed > 100) {
      setResponseStatus(event, 400);
      return { success: false, message: 'progressPercent must be 0..100.' };
    }
    progressPercent = parsed;
  }

  let pageNumber: number | null = null;
  if (rawPage !== undefined && rawPage !== null && rawPage !== '') {
    const parsed =
      typeof rawPage === 'number'
        ? rawPage
        : typeof rawPage === 'string'
          ? Number(rawPage)
          : NaN;
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setResponseStatus(event, 400);
      return { success: false, message: 'Invalid pageNumber value.' };
    }
    if (parsed < 0) {
      setResponseStatus(event, 400);
      return { success: false, message: 'pageNumber must be >= 0.' };
    }
    pageNumber = parsed;
  }

  const occurredAtParsed = parseDateInput(body.occurredAt);
  if (occurredAtParsed === 'invalid') {
    setResponseStatus(event, 400);
    return { success: false, message: 'Invalid occurredAt date.' };
  }

  try {
    const occurredAt =
      occurredAtParsed && occurredAtParsed instanceof Date
        ? occurredAtParsed
        : new Date();
    const log = await recordManualProgress(cloudDb, {
      userId,
      bookId,
      progressPercent,
      pageNumber,
      occurredAt,
    });

    return { success: true, data: { log } };
  } catch (error: unknown) {
    if (error instanceof ProgressError) {
      setResponseStatus(event, error.statusCode);
      return { success: false, message: error.message };
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(
      error,
      'POST /api/books/:id/progress-logs: Error creating log',
    );
    setResponseStatus(event, 500);
    return { success: false, message: 'Failed to create progress log' };
  }
});
