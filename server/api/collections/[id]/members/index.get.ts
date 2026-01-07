import { and, eq } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import { auth } from "~/utils/auth";
import { logger } from "~/utils/logger";
import { collectionMembers, collections, users } from "~/utils/db/schema";

/**
 * GET /api/collections/:id/members
 *
 * Minimal sharing/RBAC v1:
 * - roles: owner | editor | viewer
 * - members can be listed by owners and editors
 *
 * Guardrails:
 * - personal collections are not shareable (enforced here)
 */
export default defineEventHandler(async (event) => {
  const id =
    typeof event.context?.params?.id === "string"
      ? event.context.params.id
      : "";
  logger.debug(`GET /api/collections/${id}/members`);

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

  // Ensure collection exists and is not Personal (non-shareable)
  const c = await cloudDb
    .select({
      id: collections.id,
      isPersonal: collections.isPersonal,
    })
    .from(collections)
    .where(eq(collections.id, id))
    .limit(1);

  const collection = c[0];
  if (!collection?.id) {
    throw createError({
      statusCode: 404,
      statusMessage: "Collection not found",
    });
  }

  if (collection.isPersonal) {
    throw createError({
      statusCode: 400,
      statusMessage: "Personal collections are not shareable",
    });
  }

  // Owner/editor can list members (minimal v1)
  const userId = session.user.id;

  const membership = await cloudDb
    .select({ role: collectionMembers.role })
    .from(collectionMembers)
    .where(
      and(
        eq(collectionMembers.collectionId, id),
        eq(collectionMembers.userId, userId),
      ),
    )
    .limit(1);

  const role = membership[0]?.role;
  if (role !== "owner" && role !== "editor") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  }

  // Join users so the UI can display emails
  const members = await cloudDb
    .select({
      userId: collectionMembers.userId,
      email: users.email,
      role: collectionMembers.role,
    })
    .from(collectionMembers)
    .innerJoin(users, eq(users.id, collectionMembers.userId))
    .where(eq(collectionMembers.collectionId, id));

  return {
    success: true,
    data: {
      members: members.map((m) => ({
        userId: m.userId,
        email: m.email,
        role: m.role as "owner" | "editor" | "viewer",
      })),
    },
  };
});
