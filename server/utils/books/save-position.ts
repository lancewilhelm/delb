import { and, eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { userBookReadingPosition } from '../../../app/utils/db/schema';

type Position = {
  userId: string;
  bookId: string;
  location: string;
  progress: number | null;
  clientSessionId: string | null;
  clientSequence: number | null;
};

export async function savePosition(db: LibSQLDatabase, position: Position) {
  const table = userBookReadingPosition;
  const rows = await db
    .insert(table)
    .values({ ...position, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [table.userId, table.bookId],
      set: {
        location: sql`excluded.location`,
        progress: sql`excluded.progress`,
        clientSessionId: sql`excluded.client_session_id`,
        clientSequence: sql`excluded.client_sequence`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: sql`excluded.client_session_id IS NULL OR ${table.clientSessionId} IS NULL OR excluded.client_session_id != ${table.clientSessionId} OR excluded.client_sequence >= ${table.clientSequence}`,
    })
    .returning({ location: table.location, progress: table.progress });
  if (rows.length) return { accepted: true, position: rows[0] };
  const [current] = await db
    .select({ location: table.location, progress: table.progress })
    .from(table)
    .where(
      and(eq(table.userId, position.userId), eq(table.bookId, position.bookId)),
    )
    .limit(1);
  return {
    accepted: false,
    position: {
      location: current?.location ?? null,
      progress: current?.progress ?? null,
    },
  };
}
