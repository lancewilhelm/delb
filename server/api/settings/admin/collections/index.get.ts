import { sql } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { collectionActor } from '~~/server/utils/collections/http';
import { assertCollectionAdmin } from '~~/server/utils/collections/model';

export default defineEventHandler(async (event) => {
  const actor = await collectionActor(event);
  await assertCollectionAdmin(cloudDb, actor.id);
  const rows = await cloudDb.all<{
    id: string;
    name: string;
    ownerUserId: string;
    ownerEmail: string;
    isDefault: number;
    role: string | null;
    bookCount: number;
  }>(sql`
    SELECT c.id,c.name,c.owner_user_id AS ownerUserId,u.email AS ownerEmail,c.is_default AS isDefault,cm.role,
      (SELECT count(*) FROM books b WHERE b.collection_id=c.id) AS bookCount
    FROM collections c JOIN users u ON u.id=c.owner_user_id
    LEFT JOIN collection_members cm ON cm.collection_id=c.id AND cm.user_id=${actor.id}
    ORDER BY c.is_default DESC,c.name,c.id`);
  return {
    success: true,
    data: {
      collections: rows.map((row) => ({
        ...row,
        isDefault: Boolean(row.isDefault),
        isPersonal: false,
        canAdminister: true,
      })),
    },
  };
});
