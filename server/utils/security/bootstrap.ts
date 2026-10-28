import { eq } from 'drizzle-orm';

import { cloudDb } from '~~/server/utils/db/cloud';
import { systemState, users } from '~/utils/db/schema';

export async function claimBootstrapOwner(userId: string): Promise<boolean> {
  return cloudDb.transaction(async (tx) => {
    const claimed = await tx
      .insert(systemState)
      .values({ key: 'owner-bootstrap', value: 'complete' })
      .onConflictDoNothing()
      .returning({ key: systemState.key });
    if (!claimed.length) return false;
    const existingOwner = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'owner'))
      .limit(1);
    if (existingOwner.length) return false;
    const updated = await tx
      .update(users)
      .set({ role: 'owner' })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (!updated.length) throw new Error('Bootstrap user not found');
    return true;
  });
}
