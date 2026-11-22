import { desc, sql } from 'drizzle-orm';
import { userBookProgressLog } from '../db/schema';

// A manual entry for today may contain a date without a time. Its creation
// time orders it against other events on that same day. A backdated entry
// keeps its actual reading date instead of jumping ahead to the day it was entered.
export const progressEventTime = sql<number>`CASE
  WHEN ${userBookProgressLog.source} = 'manual'
    AND date(${userBookProgressLog.occurredAt}, 'unixepoch', 'localtime') = date(${userBookProgressLog.createdAt}, 'unixepoch', 'localtime')
    AND time(${userBookProgressLog.occurredAt}, 'unixepoch', 'localtime') = '00:00:00'
  THEN ${userBookProgressLog.createdAt}
  ELSE ${userBookProgressLog.occurredAt}
END`;

export const progressHistoryOrder = [
  desc(progressEventTime),
  desc(userBookProgressLog.occurredAt),
  desc(userBookProgressLog.createdAt),
  desc(userBookProgressLog.id),
];

type Log = {
  progressPercent: number;
  pageNumber: number | null;
  source: string;
  occurredAt: Date;
  createdAt: Date;
};
type Position = { progress: number | null; updatedAt: Date };
export type LatestProgress = {
  progressPercent: number;
  pageNumber: number | null;
  source: string;
  occurredAt: Date;
};

export function latestReadingProgress(
  log: Log | null | undefined,
  position: Position | null | undefined,
): LatestProgress | null {
  const positionTime =
    position?.progress != null ? position.updatedAt.getTime() : -Infinity;
  let logTime = -Infinity;
  if (log) {
    const occurred = log.occurredAt;
    const created = log.createdAt;
    const sameDay =
      occurred.getFullYear() === created.getFullYear() &&
      occurred.getMonth() === created.getMonth() &&
      occurred.getDate() === created.getDate();
    logTime =
      log.source === 'manual' &&
      sameDay &&
      occurred.getHours() === 0 &&
      occurred.getMinutes() === 0 &&
      occurred.getSeconds() === 0
        ? created.getTime()
        : occurred.getTime();
  }
  if (log && logTime >= positionTime)
    return {
      progressPercent: log.progressPercent,
      pageNumber: log.pageNumber,
      source: log.source,
      occurredAt: log.occurredAt,
    };
  if (position?.progress != null)
    return {
      progressPercent: position.progress,
      pageNumber: null,
      source: 'reader',
      occurredAt: position.updatedAt,
    };
  return null;
}
