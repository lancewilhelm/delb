import { cloudDb } from "~~/server/utils/db/cloud";
import { logger } from "~/utils/logger";
import { globalSettings } from "~/utils/db/schema";
import { auth } from "~/utils/auth";
import { sql } from "drizzle-orm";

/**
 * Updates the singleton global settings document.
 *
 * Access:
 * - Requires authenticated user
 * - Requires role: admin | owner
 *
 * Body:
 * {
 *   settings: Record<string, unknown>
 * }
 */
export default defineEventHandler(async (event) => {
  logger.debug("PUT /api/settings/global");

  // Ensure the user is authenticated
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    logger.error("PUT /api/settings/global: Unauthorized access attempt");
    setResponseStatus(event, 401);
    return { success: false, message: "Unauthorized" };
  }

  const user = session.user;

  // Enforce admin/owner
  if (user.role !== "admin" && user.role !== "owner") {
    logger.warn(
      { userId: user.id, role: user.role },
      "PUT /api/settings/global: Forbidden (non-admin)",
    );
    setResponseStatus(event, 403);
    return { success: false, message: "Forbidden" };
  }

  const body = await readBody<{ settings?: unknown }>(event);

  if (!body || body.settings === undefined) {
    setResponseStatus(event, 400);
    return { success: false, message: "Missing `settings` in request body" };
  }

  // We store global settings as a singleton record
  const GLOBAL_SETTINGS_ID = "00000000-0000-0000-0000-000000000000";

  try {
    const updatedAt = new Date();

    await cloudDb
      .insert(globalSettings)
      .values({
        id: GLOBAL_SETTINGS_ID,
        settings: body.settings,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: globalSettings.id,
        set: {
          settings: sql`EXCLUDED.settings`,
          updatedAt: sql`EXCLUDED.updated_at`,
        },
      });

    return { success: true, data: { updatedAt } };
  } catch (error) {
    logger.error(error, "PUT /api/settings/global: Error updating settings");
    setResponseStatus(event, 500);
    return { success: false, message: "Internal Server Error" };
  }
});
