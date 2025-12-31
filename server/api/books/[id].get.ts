import { eq } from "drizzle-orm";
import { cloudDb } from "~~/server/utils/db/cloud";
import { books } from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

export default defineEventHandler(async (event) => {
  logger.debug("GET /api/books/:id");

  // Require auth (consistent with other book endpoints)
  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Missing book id" });
  }

  try {
    const rows = await cloudDb.select().from(books).where(eq(books.id, id));
    const book = rows[0];

    if (!book) {
      throw createError({ statusCode: 404, statusMessage: "Book not found" });
    }

    return {
      success: true,
      data: {
        book,
      },
    };
  } catch (error: unknown) {
    // Preserve explicit HTTP errors (401/400/404) thrown above
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      (error as { statusCode?: unknown }).statusCode
    ) {
      throw error;
    }

    logger.error(error, "GET /api/books/:id: Error fetching book");
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to fetch book",
    });
  }
});
