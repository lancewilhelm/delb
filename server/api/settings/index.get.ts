import { cloudDb } from '~~/server/utils/db/cloud';
import { logger } from '~/utils/logger';
import { userSettings, globalSettings } from '~/utils/db/schema';
import { auth } from '~/utils/auth';
import { eq } from 'drizzle-orm';
import {
  getMetadataProviderCapabilities,
  redactGlobalSettingsForClient,
} from '~~/server/utils/secrets/hardcover';

const GLOBAL_SETTINGS_ID = '00000000-0000-0000-0000-000000000000';

export default defineEventHandler(async (event) => {
  logger.debug('GET /api/settings');

  // Ensure the user is authenticated
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return {
      success: false,
      message: 'Unauthorized',
    };
  }

  const userId = session.user.id;

  try {
    const userSettingsRes = await cloudDb
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);

    const globalSettingsRes = await cloudDb
      .select()
      .from(globalSettings)
      .where(eq(globalSettings.id, GLOBAL_SETTINGS_ID))
      .limit(1);

    const capabilities = await getMetadataProviderCapabilities();

    const globalSettingsRow = globalSettingsRes.length
      ? {
          ...globalSettingsRes[0],
          // Secrets (e.g. Hardcover token) are stored server-side in a separate table
          // and are never included in this response; the client only receives
          // non-secret settings plus capability flags.
          settings: redactGlobalSettingsForClient(
            globalSettingsRes[0]!.settings,
          ),
        }
      : null;

    return {
      success: true,
      data: {
        userSettings: userSettingsRes.length ? userSettingsRes[0] : null,
        globalSettings: globalSettingsRow,
        capabilities,
      },
    };
  } catch (error) {
    logger.error(error, 'GET /api/settings: Error fetching settings');
    setResponseStatus(event, 500);
    return {
      success: false,
      message: 'Failed to fetch settings',
    };
  }
});
