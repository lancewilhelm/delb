import { cloudDb } from "~~/server/utils/db/cloud";
import { logger } from "~/utils/logger";
import { userSettings, globalSettings } from "~/utils/db/schema";
import { auth } from "~/utils/auth";
import { eq } from "drizzle-orm";

const GLOBAL_SETTINGS_ID = "00000000-0000-0000-0000-000000000000";

export default defineEventHandler(async (event) => {
  logger.debug("GET /api/settings");

  // Ensure the user is authenticated
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    setResponseStatus(event, 401);
    return {
      success: false,
      message: "Unauthorized",
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

    return {
      success: true,
      data: {
        userSettings: userSettingsRes.length ? userSettingsRes[0] : null,
        globalSettings: globalSettingsRes.length ? globalSettingsRes[0] : null,
      },
    };
  } catch (error) {
    logger.error(error, "GET /api/settings: Error fetching settings");
    setResponseStatus(event, 500);
    return {
      success: false,
      message: "Failed to fetch settings",
    };
  }
});
