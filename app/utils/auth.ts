import { betterAuth } from "better-auth";
import { admin as baAdmin } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { cloudDb } from "~~/server/utils/db/cloud";
import * as schema from "./db/schema";
import { count } from "drizzle-orm";
import { ac, user, admin, owner } from "./permissions";

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
