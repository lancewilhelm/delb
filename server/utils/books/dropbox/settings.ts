import { cloudDb } from '~~/server/utils/db/cloud';
import { globalSettings } from '~/utils/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '~/utils/logger';

export const GLOBAL_SETTINGS_ID = '00000000-0000-0000-0000-000000000000';

export type GlobalSettingsRow = {
  settings: unknown;
  updatedAt: Date | string | number;
};

export async function getGlobalSettingsRow(): Promise<GlobalSettingsRow | null> {
  try {
    const rows = await cloudDb
      .select({
        settings: globalSettings.settings,
        updatedAt: globalSettings.updatedAt,
      })
      .from(globalSettings)
      .where(eq(globalSettings.id, GLOBAL_SETTINGS_ID))
      .limit(1);

    if (!rows[0]) return null;
    return rows[0];
  } catch (e) {
    logger.debug(e, 'getGlobalSettingsRow: failed');
    return null;
  }
}
