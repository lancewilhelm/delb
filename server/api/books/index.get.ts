import { desc } from "drizzle-orm";
import { cloudDb } from "~~/server/utils/db/cloud";
import { books } from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

export default defineEventHandler(async (event) => {
  logger.debug("GET /api/books");

  // Keep consistent with the rest of the app: require an authenticated user
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

  try {
    const rows = await cloudDb
      .select()
      .from(books)
      .orderBy(desc(books.createdAt));

    return {
      success: true,
      data: {
        books: rows,
      },
    };
  } catch (error) {
    logger.error(error, "GET /api/books: Error fetching books");
    setResponseStatus(event, 500);
    return {
      success: false,
      message: "Failed to fetch books",
    };
  }
});
