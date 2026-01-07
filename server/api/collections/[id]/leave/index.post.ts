import { and, eq } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import { auth } from "~/utils/auth";
import { logger } from "~/utils/logger";
import { collectionMembers, collections } from "~/utils/db/schema";

/**
 * POST /api/collections/:id/leave
 *
 * Allows the current user to remove themselves from a collection,
 * as long as they are NOT the owner.
 *
 * Notes / guardrails:
 * - Personal collections are not shareable and cannot be left via this endpoint.
 * - Owners cannot leave. They must delete the collection or transfer ownership.
 *
 * Response:
 * - { success: true, data: { left: boolean } }
 */
export default defineEventHandler(async (event) => {
  const id =
    typeof event.context?.params?.id === "string" ? event.context.params.id : "";
  logger.debug(`POST /api/collections/${id}/leave`);

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  if (!id) {
    throw createError({
      statusCode: 400,
      statusMessage: "Collection id is required",
    });
  }

  // Ensure collection exists and is not Personal (non-shareable / non-leavable)
  const cRows = await cloudDb
    .select({
      id: collections.id,
      isPersonal: collections.isPersonal,
    })
    .from(collections)
    .where(eq(collections.id, id))
    .limit(1);

  const c = cRows[0];
  if (!c?.id) {
    throw createError({ statusCode: 404, statusMessage: "Collection not found" });
  }

  if (c.isPersonal) {
    throw createError({
      statusCode: 400,
      statusMessage: "Personal collections cannot be left",
    });
  }

  const userId = session.user.id;

  // Ensure the user is a member and determine their role
  const membershipRows = await cloudDb
    .select({ role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(eq(collectionMembers.collectionId, id), eq(collectionMembers.userId, userId)),
    )
    .limit(1);

  const role = membershipRows[0]?.role as "owner" | "editor" | "viewer" | undefined;

  // If they're not a member, treat as no-op (don't leak membership state via errors)
  if (!role) {
    return {
      success: true,
      data: { left: false },
    };
  }

  if (role === "owner") {
    throw createError({
      statusCode: 400,
      statusMessage:
        "Owners cannot leave a collection. Delete the collection or transfer ownership instead.",
    });
  }

  await cloudDb
    .delete(collectionMembers)
    .where(
      and(eq(collectionMembers.collectionId, id), eq(collectionMembers.userId, userId)),
    );

  return {
    success: true,
    data: { left: true },
  };
});
