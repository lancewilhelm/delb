import { sql } from 'drizzle-orm';
import type { CollectionDatabase } from './model';

export async function collectionHealth(
  db: CollectionDatabase,
  sampleLimit: number,
): Promise<
  Array<{
    id: string;
    name: string;
    status: 'ok' | 'warn' | 'error';
    message: string;
    howToFix?: string;
    meta?: Record<string, unknown>;
    sample?: Array<Record<string, unknown>>;
  }>
> {
  const [defaultCount] = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM collections WHERE is_default=1`,
  );
  const owners = await db.all<{
    id: string;
    name: string;
  }>(sql`SELECT c.id,c.name FROM collections c WHERE
    (SELECT count(*) FROM collection_members cm WHERE cm.collection_id=c.id AND cm.role='owner')!=1 OR
    NOT EXISTS(SELECT 1 FROM collection_members cm WHERE cm.collection_id=c.id AND cm.user_id=c.owner_user_id AND cm.role='owner')`);
  const invalidBooks = await db.all<{
    id: string;
    title: string;
    collectionId: string | null;
  }>(
    sql`SELECT b.id,b.title,b.collection_id AS collectionId FROM books b LEFT JOIN collections c ON c.id=b.collection_id WHERE b.collection_id IS NULL OR c.id IS NULL ORDER BY b.id`,
  );
  const groups = await db.all<{ title: string; n: number }>(
    sql`SELECT lower(trim(title)) AS title,count(*) AS n FROM books GROUP BY lower(trim(title)) HAVING count(DISTINCT collection_id)>1 ORDER BY lower(trim(title))`,
  );
  const samples = [];
  for (const group of groups.slice(0, sampleLimit)) {
    const matches = await db.all<{
      id: string;
      title: string;
      collectionId: string;
      collectionName: string;
    }>(
      sql`SELECT b.id,b.title,b.collection_id AS collectionId,c.name AS collectionName FROM books b JOIN collections c ON c.id=b.collection_id WHERE lower(trim(b.title))=${group.title} ORDER BY b.id LIMIT ${sampleLimit}`,
    );
    samples.push({
      title: group.title,
      bookCount: group.n,
      matches,
      sampled: matches.length < group.n,
    });
  }
  return [
    {
      id: 'collections.default',
      name: 'Shared default collection',
      status: defaultCount?.n === 1 ? 'ok' : 'error',
      message:
        defaultCount?.n === 1
          ? 'One default collection is configured'
          : 'Exactly one default collection is required',
      meta: { defaultCount: defaultCount?.n ?? 0 },
    },
    {
      id: 'collections.owners',
      name: 'Required collection owners',
      status: owners.length ? 'error' : 'ok',
      message: owners.length
        ? `${owners.length} collection(s) have inconsistent ownership`
        : 'Every collection has one matching owner',
      sample: owners.slice(0, sampleLimit),
    },
    {
      id: 'collections.membership',
      name: 'Exclusive book collections',
      status: invalidBooks.length ? 'error' : 'ok',
      message: invalidBooks.length
        ? `${invalidBooks.length} book(s) have no valid collection`
        : 'Every book belongs to one existing collection',
      howToFix: invalidBooks.length
        ? 'Review the affected entries and restore the matching migration backup or repair their destination before resuming imports.'
        : undefined,
      meta: { invalidBookCount: invalidBooks.length },
      sample: invalidBooks.slice(0, sampleLimit),
    },
    {
      id: 'duplicates.cross-collection-titles',
      name: 'Matching titles across collections',
      status: groups.length ? 'warn' : 'ok',
      message: groups.length
        ? `${groups.length} matching title group(s) across collections. Independent entries are allowed.`
        : 'No identical titles found across collections',
      howToFix: groups.length
        ? 'Review the matching entries. Different editions and independent copies are valid. No automatic merge or deletion is performed.'
        : undefined,
      meta: {
        duplicateGroupCount: groups.length,
        sampled: groups.length > sampleLimit,
        complete: true,
      },
      sample: samples,
    },
  ];
}
