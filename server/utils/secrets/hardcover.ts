import { cloudDb } from '~~/server/utils/db/cloud';
import { eq } from 'drizzle-orm';
import { globalSettings } from '~/utils/db/schema';

/**
 * Server-side Hardcover token storage.
 *
 * IMPORTANT:
 * - The token is stored inside the existing singleton `global_settings.settings` JSON blob
 *   under a PRIVATE, server-only key (`_secrets.hardcoverToken`).
 * - Client-facing settings should NEVER include `_secrets`.
 *   Make sure `/api/settings` redacts `_secrets` before returning global settings to the client.
 *
 * Why store here at all?
 * - This avoids introducing new tables/migrations while still keeping the token server-side.
 * - The “never sent to client” guarantee is enforced by the settings API (redaction),
 *   not by the database schema.
 */

const GLOBAL_SETTINGS_ID = '00000000-0000-0000-0000-000000000000';

export const HARDCOVER_SECRETS_PATH = '_secrets.hardcoverToken' as const;

type GlobalSettingsJson = Record<string, unknown>;

type SecretsContainer = {
  hardcoverToken?: unknown;
};

function normalizeToken(raw: string): string {
  // Accept raw token or "Bearer <token>"
  return raw.trim().replace(/^Bearer\s+/i, '');
}

function getSecretsContainer(settings: GlobalSettingsJson): SecretsContainer {
  const secrets = settings._secrets;
  if (!secrets || typeof secrets !== 'object') return {};
  return secrets as SecretsContainer;
}

function setSecretsContainer(
  settings: GlobalSettingsJson,
  nextSecrets: SecretsContainer,
): GlobalSettingsJson {
  return {
    ...settings,
    _secrets: {
      ...(typeof settings._secrets === 'object' && settings._secrets
        ? (settings._secrets as Record<string, unknown>)
        : {}),
      ...nextSecrets,
    },
  };
}

/**
 * Returns the full raw singleton row (or null if it doesn't exist).
 */
async function readGlobalSettingsRow() {
  const res = await cloudDb
    .select()
    .from(globalSettings)
    .where(eq(globalSettings.id, GLOBAL_SETTINGS_ID))
    .limit(1);

  return res.length ? res[0] : null;
}

/**
 * Read the Hardcover token from server-side secrets (never from env).
 * Returns empty string if not configured.
 */
export async function getHardcoverToken(): Promise<string> {
  const row = await readGlobalSettingsRow();
  const settings = (row?.settings ?? {}) as GlobalSettingsJson;

  const secrets = getSecretsContainer(settings);
  const raw =
    typeof secrets.hardcoverToken === 'string' ? secrets.hardcoverToken : '';
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
 *
 * NOTE:
 * This performs a read-modify-write of the global settings JSON.
 * If you have concurrent writers to global settings, you may want to
 * introduce a dedicated secrets table or a more robust merge strategy.
 */
export async function setHardcoverToken(tokenRaw: string): Promise<void> {
  const normalized = normalizeToken(tokenRaw);

  // Load existing settings JSON (or default empty object if none).
  const row = await readGlobalSettingsRow();
  const currentSettings = (row?.settings ?? {}) as GlobalSettingsJson;

  const nextSettings = setSecretsContainer(currentSettings, {
    hardcoverToken: normalized,
  });

  // Upsert the singleton row.
  const updatedAt = new Date();

  // We intentionally rely on drizzle's upsert pattern used elsewhere in the project.
  // Import is avoided here to keep this helper standalone; callers (API routes)
  // should perform the upsert if they need conflict handling customization.
  await cloudDb
    .insert(globalSettings)
    .values({
      id: GLOBAL_SETTINGS_ID,
      settings: nextSettings,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: globalSettings.id,
      set: {
        settings: nextSettings,
        updatedAt,
      },
    });
}

/**
 * Redact server-only secrets from a global settings JSON blob before sending to clients.
 * Use this in `/api/settings` (and anywhere else global settings are returned).
 */
export function redactGlobalSettingsForClient(
  settings: unknown,
): Record<string, unknown> {
  const obj: Record<string, unknown> =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : {};

  // Drop the entire `_secrets` object.
  // If you later need to expose capability flags, expose them separately (e.g. `hardcoverEnabled`).
  // Do NOT leak tokens.
  const { _secrets, ...rest } = obj;

  return rest;
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
