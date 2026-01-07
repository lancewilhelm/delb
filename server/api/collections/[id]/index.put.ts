import { and, eq } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import { auth } from "~/utils/auth";
import { logger } from "~/utils/logger";
import { collectionMembers, collections } from "~/utils/db/schema";

/**
 * PUT /api/collections/:id
 *
 * v1 scope:
 * - update name only
 *
 * Permissions:
 * - must be a member with role: "owner" | "editor"
 */
export default defineEventHandler(async (event) => {
  const id = typeof event.context?.params?.id === "string" ? event.context.params.id : "";
  logger.debug(`PUT /api/collections/${id}`);

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Collection id is required" });
  }

  const body = (await readBody(event).catch(() => null)) as {
    name?: unknown;
  } | null;

  const rawName = typeof body?.name === "string" ? body.name : "";
  const name = rawName.trim();

  if (!name) {
    throw createError({
      statusCode: 400,
      statusMessage: "Collection name is required",
    });
  }

  // Keep this lean; you can tune limits later.
  if (name.length > 120) {
    throw createError({
      statusCode: 400,
      statusMessage: "Collection name is too long",
    });
  }

  const userId = session.user.id;

  const membership = await cloudDb
    .select({
      role: collectionMembers.role,
    })
    .from(collectionMembers)
    .where(and(eq(collectionMembers.collectionId, id), eq(collectionMembers.userId, userId)))
    .limit(1);

  const role = membership[0]?.role;
  if (role !== "owner" && role !== "editor") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  }

  // Ensure the collection exists (and avoid updating a missing row silently).
  const existing = await cloudDb
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.id, id))
    .limit(1);

  if (!existing[0]?.id) {
    throw createError({ statusCode: 404, statusMessage: "Collection not found" });
  }

  const now = new Date();

  await cloudDb
    .update(collections)
    .set({
      name,
      updatedAt: now,
    })
    .where(eq(collections.id, id));

  return {
    success: true,
    data: {
      collection: { id, name },
    },
  };
});
