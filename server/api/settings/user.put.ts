import { and, eq, lt, sql } from 'drizzle-orm';
import { cloudDb } from '~~/server/utils/db/cloud';
import { userSettings } from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { logger } from '~/utils/logger';

type UserSettingsPutBody = {
  settings: unknown;
  updatedAt?: string | number | Date;
};

function coerceDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export default defineEventHandler(async (event) => {
  logger.debug('PUT /api/settings/user');

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return { success: false, message: 'Unauthorized' };
  }

  const body = await readBody<UserSettingsPutBody>(event);

  // The client owns the settings shape; we store a JSON blob.
  if (!body || body.settings === undefined) {
    setResponseStatus(event, 400);
    return { success: false, message: 'Missing `settings`' };
  }

  const updatedAt = coerceDate(body.updatedAt ?? new Date());

  try {
    const written = await cloudDb
      .insert(userSettings)
      .values({
        userId: session.user.id,
        settings: body.settings,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: {
          settings: sql`EXCLUDED.settings`,
          updatedAt: sql`EXCLUDED.updated_at`,
        },
        // Only update if the incoming payload is newer than what's stored.
        // This prevents older clients/tabs from overwriting newer settings.
        where: and(
          eq(userSettings.userId, session.user.id),
          lt(userSettings.updatedAt, updatedAt),
        ),
      })
      .returning();

    if (written.length)
      return { success: true, accepted: true, data: written[0] };
    const current = await cloudDb
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, session.user.id))
      .limit(1);
    const stored = current[0];
    const matches =
      stored?.updatedAt.getTime() === updatedAt.getTime() &&
      JSON.stringify(stored.settings) === JSON.stringify(body.settings);
    return { success: true, accepted: matches, data: stored ?? null };
  } catch (error) {
    logger.error(error, 'PUT /api/settings/user: Error updating user settings');
    setResponseStatus(event, 500);
    return { success: false, message: 'Internal Server Error' };
  }
});
