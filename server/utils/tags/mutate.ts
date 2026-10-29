import { and, eq, sql } from 'drizzle-orm';
import { bookTags, tags } from '../../../app/utils/db/schema';
import { visibleEntity } from '../books/visibility';
import type { cloudDb } from '../db/cloud';

type Command =
  | { kind: 'delete'; sourceId: string }
  | { kind: 'merge'; sourceId: string; targetId: string };

export class TagMutationError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function mutateTag(
  db: typeof cloudDb,
  userId: string,
  command: Command,
) {
  if (command.kind === 'merge' && command.sourceId === command.targetId) {
    throw new TagMutationError(400, 'Choose a different destination tag');
  }
  return db.transaction(async (tx) => {
    const ids =
      command.kind === 'merge'
        ? [command.sourceId, command.targetId]
        : [command.sourceId];
    for (const id of ids) {
      const found = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.id, id), visibleEntity('tag', userId)))
        .limit(1);
      if (!found.length) throw new TagMutationError(404, 'Tag not found');
    }
    if (command.kind === 'merge') {
      await tx.run(
        sql`INSERT INTO ${bookTags} (book_id, tag_id) SELECT book_id, ${command.targetId} FROM ${bookTags} WHERE tag_id = ${command.sourceId} ON CONFLICT(book_id, tag_id) DO NOTHING`,
      );
    }
    await tx.delete(bookTags).where(eq(bookTags.tagId, command.sourceId));
    await tx.delete(tags).where(eq(tags.id, command.sourceId));
  });
}
