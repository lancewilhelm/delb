import { cloudDb } from '~~/server/utils/db/cloud';
import { eq } from 'drizzle-orm';
import { globalSecrets } from '~/utils/db/schema';

/**
 * Server-side Hardcover token storage.
 *
 * IMPORTANT:
 * - The token is stored in a dedicated `global_secrets` table (server-only).
 * - Tokens are NEVER returned to the client. Clients only receive capability flags.
 */

export const HARDCOVER_SECRET_ID = 'hardcoverToken' as const;

function normalizeToken(raw: string): string {
  // Accept raw token or "Bearer <token>"
  return raw.trim().replace(/^Bearer\s+/i, '');
}

/**
 * Read the Hardcover token from server-side secrets (never from env).
 * Returns empty string if not configured.
 */
export async function getHardcoverToken(): Promise<string> {
  const res = await cloudDb
    .select()
    .from(globalSecrets)
    .where(eq(globalSecrets.id, HARDCOVER_SECRET_ID))
    .limit(1);

  const raw = res.length ? (res[0]?.value ?? '') : '';
  return raw ? normalizeToken(raw) : '';
}

/**
 * True if a non-empty token exists in server-side secrets.
 */
export async function hasHardcoverToken(): Promise<boolean> {
  const token = await getHardcoverToken();
  return !!token;
}

/**
 * Store (or clear) the Hardcover token in server-side secrets.
 *
 * - `tokenRaw`: raw token or "Bearer <token>"
 * - Pass empty string to clear.
 */
export async function setHardcoverToken(tokenRaw: string): Promise<void> {
  const normalized = normalizeToken(tokenRaw);
  const updatedAt = new Date();

  await cloudDb
    .insert(globalSecrets)
    .values({
      id: HARDCOVER_SECRET_ID,
      value: normalized,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: globalSecrets.id,
      set: {
        value: normalized,
        updatedAt,
      },
    });
}

/**
 * Redact server-only secrets from a global settings JSON blob before sending to clients.
 *
 * With secrets now stored in `global_secrets`, this is a no-op passthrough for
 * backwards compatibility with existing callers.
 */
export function redactGlobalSettingsForClient(
  settings: unknown,
): Record<string, unknown> {
  return settings && typeof settings === 'object'
    ? (settings as Record<string, unknown>)
    : {};
}

/**
 * Build a minimal capability object the client can use to enable/disable provider toggles.
 * This returns NO secrets.
 */
export async function getMetadataProviderCapabilities(): Promise<{
  hardcoverAvailable: boolean;
}> {
  return {
    hardcoverAvailable: await hasHardcoverToken(),
  };
}
