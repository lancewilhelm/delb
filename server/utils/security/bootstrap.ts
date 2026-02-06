import { count, eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { users } from '~/utils/db/schema';

export async function claimBootstrapOwner(userId: string): Promise<boolean> {
  return cloudDb.transaction(async (tx) => {
    const ownerCountRows = await tx
      .select({ count: count() })
      .from(users)
      .where(eq(users.role, 'owner'));

    const ownerCount = ownerCountRows[0]?.count ?? 0;
    if (ownerCount > 0) return false;

    await tx.update(users).set({ role: 'owner' }).where(eq(users.id, userId));

    return true;
  });
}
