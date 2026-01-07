import { betterAuth } from "better-auth";
import { admin as baAdmin } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { cloudDb } from "~~/server/utils/db/cloud";
import * as schema from "./db/schema";
import { count, and, eq } from "drizzle-orm";
import { ac, user, admin, owner } from "./permissions";

async function ensurePersonalCollectionForUser(userId: string) {
  const existing = await cloudDb
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.ownerUserId, userId),
        eq(schema.collections.isPersonal, true),
      ),
    )
    .limit(1);

  if (existing[0]?.id) return;

  const now = new Date();
  const collectionId = crypto.randomUUID();

  await cloudDb.insert(schema.collections).values({
    id: collectionId,
    name: "Personal",
    ownerUserId: userId,
    isPersonal: true,
    createdAt: now,
    updatedAt: now,
  });

  await cloudDb.insert(schema.collectionMembers).values({
    collectionId,
    userId,
    role: "owner",
    createdAt: now,
  });
}

/**
 * Backfill a Personal collection for existing users (one-time style).
 *
 * Why:
 * - Some users may exist from before we introduced personal collections.
 * - Some users may be created by an admin and never sign in, so session hooks won't run.
 *
 * Notes:
 * - This runs on module initialization, best-effort.
 * - It intentionally does not throw if it fails; auth should still boot.
 */
(async function backfillPersonalCollectionsOnStartup() {
  try {
    const allUsers = await cloudDb
      .select({ id: schema.users.id })
      .from(schema.users);

    for (const u of allUsers) {
      if (!u?.id) continue;
      await ensurePersonalCollectionForUser(u.id);
    }
  } catch {
    // best-effort; avoid breaking auth init if db is unavailable during bootstrap
  }
})();

export const auth = betterAuth({
  baseURL: getBaseURL(),
  trustedOrigins: getTrustedOrigins(),
  advanced: {
    cookiePrefix: "delb",
  },
  plugins: [
    baAdmin({
      ac,
      roles: {
        user,
        admin,
        owner,
      },
    }),
  ],
  database: drizzleAdapter(cloudDb, {
    provider: "sqlite",
    schema: {
      ...schema,
    },
    usePlural: true,
  }),
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: true,
        defaultValue: "user",
        input: false,
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
    autoSignIn: true,
  },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          // Ensure Personal collection exists even for users created outside the normal
          // registration flow (e.g. admin-created users).
          await ensurePersonalCollectionForUser(session.userId);
        },
      },
    },
    user: {
      create: {
        before: async (user) => {
          // Check if registration is allowed
          const response = await cloudDb.select().from(schema.globalSettings);
          const settings = response[0]?.settings as GlobalSettings;
          const allowRegistration =
            settings === undefined || settings.allowRegistration;

          if (!allowRegistration) {
            throw new APIError("UNAUTHORIZED", {
              message: "Registration is closed.",
            });
          }

          // Determine if this is the first user
          const userCount = await cloudDb
            .select({ count: count() })
            .from(schema.users);
          const isFirstUser = !userCount[0] || userCount[0].count === 0;
          const role = isFirstUser ? "owner" : "user";

          return {
            data: {
              ...user,
              role,
            },
          };
        },
        after: async (createdUser) => {
          // Normal sign-up path: eagerly create Personal collection.
          await ensurePersonalCollectionForUser(createdUser.id);
        },
      },
    },
  },
});

function getBaseURL() {
  let baseURL = process.env.BETTER_AUTH_URL;
  if (!baseURL) {
    try {
      baseURL = getRequestURL(useEvent()).origin;
    } catch {
      //pass
    }
  }
  return baseURL;
}

function getTrustedOrigins() {
  const origins = process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  if (!origins) return [];
  return origins.split(",").map((origin) => origin.trim());
}
