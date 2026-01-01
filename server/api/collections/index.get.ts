import { eq } from "drizzle-orm";

import { cloudDb } from "~~/server/utils/db/cloud";
import { collections, collectionMembers } from "~/utils/db/schema";
import { logger } from "~/utils/logger";
import { auth } from "~/utils/auth";

/**
 * GET /api/collections
 *
 * Returns collections the current user can see (is a member of).
 * The upload UI uses this list as "collections you can upload to", but the server
 * should still enforce permissions when uploading.
 *
 * v1 behavior:
 * - returns collections where the user is a member (any role)
 * - client can filter further if desired
 */
export default defineEventHandler(async (event) => {
  logger.debug("GET /api/collections");

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const userId = session.user.id;

  // Simple, portable approach: load memberships then fetch collections by id.
  // (Avoids needing complex joins if drizzle typing/setup changes.)
  const memberships = await cloudDb
    .select({
      collectionId: collectionMembers.collectionId,
      role: collectionMembers.role,
    })
    .from(collectionMembers)
    .where(eq(collectionMembers.userId, userId));

  const uniqueIds = Array.from(
    new Set(memberships.map((m) => m.collectionId)),
  ).filter(Boolean);

  if (!uniqueIds.length) {
    return {
      success: true,
      data: {
        collections: [],
      },
    };
  }

  // Fetch each collection (small N in v1, keeps SQLite queries simple).
  const rows = await Promise.all(
    uniqueIds.map(async (id) => {
      const res = await cloudDb
        .select({
          id: collections.id,
          name: collections.name,
          ownerUserId: collections.ownerUserId,
        })
        .from(collections)
        .where(eq(collections.id, id))
        .limit(1);

      const c = res[0];
      if (!c) return null;

      const role =
        memberships.find((m) => m.collectionId === id)?.role ?? "viewer";

      return { ...c, role };
    }),
  );

  const out = rows.filter((r): r is NonNullable<typeof r> => r !== null);

  return {
    success: true,
    data: {
      collections: out,
    },
  };
});
