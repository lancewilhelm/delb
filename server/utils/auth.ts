import {
  assertAccountDeletionAllowed,
  assertCollectionAdmin,
  CollectionError,
  requireCollectionModel,
} from '~~/server/utils/collections/model';
import { betterAuth } from 'better-auth';
import { admin as baAdmin } from 'better-auth/plugins';
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { cloudDb } from '~~/server/utils/db/cloud';
import * as schema from './db/schema';
import { count, eq } from 'drizzle-orm';
import { ac, user, admin, owner } from './permissions';
import type { GlobalSettings } from '~/stores/globalSettings';
import { logger } from '~/utils/logger';
import { claimBootstrapOwner } from '~~/server/utils/security/bootstrap';

export const auth = betterAuth({
  baseURL: getBaseURL(),
  trustedOrigins: getTrustedOrigins(),
  advanced: {
    cookiePrefix: 'delb',
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (
        context.path !== '/admin/remove-user' &&
        context.path !== '/delete-user'
      )
        return;
      const session = await getSessionFromCtx(context);
      if (!session)
        throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
      const body: unknown = context.body;
      const targetId =
        context.path === '/delete-user'
          ? session.user.id
          : body &&
              typeof body === 'object' &&
              'userId' in body &&
              typeof body.userId === 'string'
            ? body.userId
            : null;
      if (!targetId) return;
      if (context.path === '/admin/remove-user') {
        try {
          await assertCollectionAdmin(cloudDb, session.user.id);
        } catch {
          throw new APIError('FORBIDDEN', {
            message: 'Administrator access required',
          });
        }
      }
      await guardUserDeletion(targetId);
    }),
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
    provider: 'sqlite',
    schema: {
      ...schema,
    },
    usePlural: true,
  }),
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: true,
        defaultValue: 'user',
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
      update: {
        before: async (changes, context) => {
          if (changes.role === undefined) return;
          const targetId =
            context?.body && typeof context.body.userId === 'string'
              ? context.body.userId
              : null;
          if (!targetId)
            throw new APIError('FORBIDDEN', {
              message: 'Role change target is required.',
            });
          const target = await cloudDb
            .select({ role: schema.users.role })
            .from(schema.users)
            .where(eq(schema.users.id, targetId))
            .limit(1);
          if (
            target[0]?.role === 'owner' ||
            (typeof changes.role === 'string' &&
              changes.role.split(',').includes('owner'))
          ) {
            throw new APIError('FORBIDDEN', {
              message: 'The system owner role cannot be changed.',
            });
          }
        },
      },
      delete: {
        before: async (user) => {
          await guardUserDeletion(user.id);
        },
      },
      create: {
        before: async (user) => {
          // Determine whether creation is coming from admin endpoints (avoid circular auth reference)
          let isAdminCreator = false;
          try {
            const event = useEvent();
            const pathname = getRequestURL(event).pathname;
            isAdminCreator =
              typeof pathname === 'string' &&
              pathname.includes('/api/auth/admin');
          } catch (error) {
            logger.debug({ error }, 'Failed to determine request context');
            // no-op: assume not admin if request context cannot be determined
          }

          const userInput = user as Record<string, unknown>;
          const sanitizedUser = { ...userInput };

          const userCountRows = await cloudDb
            .select({ count: count() })
            .from(schema.users);
          const isFirstRegistration = (userCountRows[0]?.count ?? 0) === 0;
          if (!isFirstRegistration) await requireCollectionModel(cloudDb);

          // Fetch global settings for registration checks
          const response = await cloudDb.select().from(schema.globalSettings);
          const settings = response[0]?.settings as GlobalSettings;

          // Enforce registration toggle for non-admin creators and non-first registrations.
          if (!isAdminCreator && !isFirstRegistration) {
            const allowRegistration =
              settings === undefined || settings.allowRegistration;

            if (!allowRegistration) {
              throw new APIError('UNAUTHORIZED', {
                message: 'Registration is closed.',
              });
            }
          }

          // Determine final role:
          // - first user is promoted atomically in `after`
          // - admin-created users honor requested role
          // - self-registrations are always 'user'
          let finalRole: 'admin' | 'user';

          if (isAdminCreator) {
            const maybeRole = (user as { role?: unknown }).role;
            const requestedRole =
              typeof maybeRole === 'string' &&
              (maybeRole === 'admin' || maybeRole === 'user')
                ? (maybeRole as 'admin' | 'user')
                : 'user';
            finalRole = requestedRole;
          } else {
            finalRole = 'user';
          }

          return {
            data: {
              ...sanitizedUser,
              role: finalRole,
            },
          };
        },
        after: async (createdUser) => {
          // Concurrency-safe owner bootstrap claim:
          // first successful claimant becomes owner and marks completion atomically.
          const promoted = await claimBootstrapOwner(createdUser.id);
          if (promoted) {
            logger.info(
              { userId: createdUser.id },
              'Initial system owner bootstrap completed',
            );
          }
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
  return origins.split(',').map((origin) => origin.trim());
}

async function guardUserDeletion(userId: string) {
  try {
    await assertAccountDeletionAllowed(cloudDb, userId);
  } catch (error) {
    if (error instanceof CollectionError)
      throw new APIError(
        error.statusCode === 403 ? 'FORBIDDEN' : 'BAD_REQUEST',
        { message: error.message },
      );
    throw error;
  }
}
