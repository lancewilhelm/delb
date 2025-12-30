import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";
import { cloudDb } from "~~/server/utils/db/cloud";
import { users } from "~/utils/db/schema";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  logger.debug("DELETE /api/users/delete");

  // Ensure the user is authenticated
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session || session.user.role !== "admin") {
    logger.error("DELETE /api/users/delete: Unauthorized access attempt");
    setResponseStatus(event, 401);
    return {
      message: "Unauthorized",
    };
  }

  // Parse the request body
  const { id }: { id: string } = await readBody(event);
  if (!id) {
    logger.error("DELETE /api/users/delete: Invalid request, userId required");
    setResponseStatus(event, 400);
    return { message: "Invalid request: userId required" };
  }

  try {
    // Delete the user from the database
    await cloudDb.delete(users).where(eq(users.id, id));

    return { success: true };
  } catch (error) {
    logger.error(error, "DELETE /api/users/delete: Error deleting user");
    setResponseStatus(event, 500);
    return { message: "Internal server error" };
  }
});
