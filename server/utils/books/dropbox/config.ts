import path from 'node:path';

export type DropboxIngestSettings = {
  enabled?: boolean;
  dir?: string;
  extensions?: string[] | string;
  pollIntervalMs?: number;
  stablePassesRequired?: number;
  stableMaxAgeMs?: number;

  /**
   * Optional: choose the destination collection directly.
   * If omitted, we default to a Personal collection.
   */
  targetCollectionId?: string;
  /**
   * Optional: add newly ingested books to these collections in addition to the owner's Personal collection.
   */
  additionalCollectionIds?: string[];

  /**
   * Optional: used only when `targetCollectionId` is not provided, to select
   * which user's Personal collection we should ingest into.
   */
  targetUserId?: string;
  targetUserEmail?: string;
};

export type DropboxIngestConfig = {
  enabled: boolean;
  dropboxDirAbs: string;
  dropboxDirRel: string;
  failedDirAbs: string;
  pollIntervalMs: number;
  stablePassesRequired: number;
  stableMaxAgeMs: number;
  allowedExtensions: ReadonlySet<string>;
};

export const DEFAULT_DROPBOX_INGEST_SETTINGS: Required<
  Pick<
    DropboxIngestSettings,
    | 'enabled'
    | 'dir'
    | 'extensions'
    | 'pollIntervalMs'
    | 'stablePassesRequired'
    | 'stableMaxAgeMs'
  >
> = {
  enabled: true,
  dir: 'dropbox',
  extensions: ['.epub', '.pdf', '.mobi', '.azw3'],
  pollIntervalMs: 2500,
  stablePassesRequired: 2,
  stableMaxAgeMs: 5 * 60 * 1000,
};

function parseBool(v: unknown, fallback: boolean): boolean {
  const raw = (v ?? '').toString().trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on')
    return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
    return false;
  return fallback;
}

function parseIntSetting(v: unknown, fallback: number): number {
  const n = Number.parseInt((v ?? '').toString(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseExtensions(v: unknown): ReadonlySet<string> {
  const rawList =
    Array.isArray(v) ? v.map((x) => (x ?? '').toString()) : null;
  const rawString = !rawList ? (v ?? '').toString().trim() : '';

  const parts = rawList
    ? rawList.map((s) => s.trim())
    : rawString
      ? rawString.split(',').map((s) => s.trim())
      : (DEFAULT_DROPBOX_INGEST_SETTINGS.extensions as string[]).slice();

  const normalized = parts
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : `.${s}`))
    .map((s) => s.toLowerCase());

  return new Set(normalized);
}

export function parseDropboxIngestSettings(
  settings: unknown,
): DropboxIngestSettings {
  if (!settings || typeof settings !== 'object') return {};
  const root = settings as Record<string, unknown>;
  const dropbox = root.dropbox;
  if (!dropbox || typeof dropbox !== 'object') return {};
  return dropbox as DropboxIngestSettings;
}

export function getDropboxIngestConfigFromSettings(
  settings: unknown,
): DropboxIngestConfig {
  const dropbox = parseDropboxIngestSettings(settings);

  const enabled = parseBool(
    dropbox.enabled,
    DEFAULT_DROPBOX_INGEST_SETTINGS.enabled,
  );

  const dropboxDirRel =
    (dropbox.dir ?? '').toString().trim() || DEFAULT_DROPBOX_INGEST_SETTINGS.dir;
  const dropboxDirAbs = path.resolve(process.cwd(), dropboxDirRel);

  const failedDirAbs = path.join(dropboxDirAbs, 'failed');

  return {
    enabled,
    dropboxDirAbs,
    dropboxDirRel,
    failedDirAbs,
    pollIntervalMs: parseIntSetting(
      dropbox.pollIntervalMs,
      DEFAULT_DROPBOX_INGEST_SETTINGS.pollIntervalMs,
    ),
    stablePassesRequired: parseIntSetting(
      dropbox.stablePassesRequired,
      DEFAULT_DROPBOX_INGEST_SETTINGS.stablePassesRequired,
    ),
    stableMaxAgeMs: parseIntSetting(
      dropbox.stableMaxAgeMs,
      DEFAULT_DROPBOX_INGEST_SETTINGS.stableMaxAgeMs,
    ),
    allowedExtensions: parseExtensions(dropbox.extensions),
  };
}
