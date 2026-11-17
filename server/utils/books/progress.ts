import { and, eq } from 'drizzle-orm';
import {
  books,
  userBookPreferences,
  userBookProgressLog,
  userBookReadingPosition,
} from '~/utils/db/schema';
import type { cloudDb } from '~~/server/utils/db/cloud';
import { visibleBook } from './visibility';
import { latestReadingProgress, progressHistoryOrder } from './progress-order';

type Db = typeof cloudDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

type Target = { userId: string; bookId: string };

export class ProgressError extends Error {
  constructor(
    public statusCode: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

async function visibleBookWithPages(tx: Tx, { userId, bookId }: Target) {
  const [book] = await tx
    .select({ id: books.id, pages: books.pages })
    .from(books)
    .where(and(eq(books.id, bookId), visibleBook(userId)))
    .limit(1);
  if (!book) throw new ProgressError(404, 'Book not found');
  return book;
}

export async function recordManualProgress(
  db: Db,
  input: Target & {
    progressPercent: number | null;
    pageNumber: number | null;
    occurredAt: Date;
    authorize?: (tx: Tx) => Promise<void>;
  },
) {
  return db.transaction(async (tx) => {
    if (input.authorize) await input.authorize(tx);
    const book = await visibleBookWithPages(tx, input);
    let progressPercent = input.progressPercent;
    if (input.pageNumber !== null) {
      if (!book.pages || book.pages <= 0)
        throw new ProgressError(
          400,
          'This book has no page count. Add pages to log by page.',
        );
      if (input.pageNumber > book.pages)
        throw new ProgressError(400, `pageNumber must be <= ${book.pages}.`);
      progressPercent = (input.pageNumber / book.pages) * 100;
    }
    if (progressPercent === null)
      throw new ProgressError(400, 'Provide progressPercent or pageNumber.');
    const log = {
      id: crypto.randomUUID(),
      userId: input.userId,
      bookId: input.bookId,
      progressPercent,
      pageNumber: input.pageNumber,
      location: null,
      source: 'manual',
      occurredAt: input.occurredAt,
      createdAt: new Date(),
    };
    await tx.insert(userBookProgressLog).values(log);
    return log;
  });
}

export async function readReadingProgress(
  db: Db,
  input: Target & { limit: number },
) {
  return db.transaction(async (tx) => {
    const book = await visibleBookWithPages(tx, input);
    const [preference] = await tx
      .select({ enabled: userBookPreferences.progressSyncEnabled })
      .from(userBookPreferences)
      .where(
        and(
          eq(userBookPreferences.userId, input.userId),
          eq(userBookPreferences.bookId, input.bookId),
        ),
      )
      .limit(1);
    const [position] = await tx
      .select({
        progress: userBookReadingPosition.progress,
        updatedAt: userBookReadingPosition.updatedAt,
      })
      .from(userBookReadingPosition)
      .where(
        and(
          eq(userBookReadingPosition.userId, input.userId),
          eq(userBookReadingPosition.bookId, input.bookId),
        ),
      )
      .limit(1);
    const history = await tx
      .select({
        id: userBookProgressLog.id,
        progressPercent: userBookProgressLog.progressPercent,
        pageNumber: userBookProgressLog.pageNumber,
        source: userBookProgressLog.source,
        occurredAt: userBookProgressLog.occurredAt,
        createdAt: userBookProgressLog.createdAt,
      })
      .from(userBookProgressLog)
      .where(
        and(
          eq(userBookProgressLog.userId, input.userId),
          eq(userBookProgressLog.bookId, input.bookId),
        ),
      )
      .orderBy(...progressHistoryOrder)
      .limit(input.limit);
    return {
      bookId: book.id,
      pageCount: book.pages,
      progressSyncEnabled: preference?.enabled ?? false,
      readerPosition: position ?? null,
      history,
      latest: latestReadingProgress(history[0], position),
    };
  });
}
