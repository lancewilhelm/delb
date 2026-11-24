import type { DashboardOverview } from '#shared/types/dashboard';

/** A personal shelf as the dashboard shows it (`GET /api/shelves`). */
export type DashboardShelfSummary = {
  id: string;
  name: string;
  count: number;
  previews: { id: string; title: string; spineRevision?: string | null }[];
};

const STORAGE_PREFIX = 'delb.dashboardCache.v2:';
const LEGACY_PREFIXES = ['delb.dashboardCache.v1:'];
const MAX_ENTRIES = 24;

type CacheEntry<T> = { data: T; cachedAt: number };

const memoryCache = new Map<string, CacheEntry<unknown>>();

function readStored<T>(key: string): CacheEntry<T> | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T> | null;
    return parsed && parsed.data ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, entry: CacheEntry<unknown>) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(entry));
  } catch {
    // Ignore storage quota / private mode failures.
  }
}

function read<T>(key: string): T | null {
  let entry = memoryCache.get(key) as CacheEntry<T> | undefined;
  if (!entry) {
    const stored = readStored<T>(key);
    if (!stored) return null;
    entry = stored;
    memoryCache.set(key, entry);
  }
  return structuredClone(entry.data);
}

function write<T>(key: string, data: T) {
  const entry = { data: structuredClone(data), cachedAt: Date.now() };
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  while (memoryCache.size > MAX_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
  writeStored(key, entry);
}

const overviewKey = (userId: string, scope: string) =>
  `${userId}::${scope || 'all'}::overview`;
const shelvesKey = (userId: string) => `${userId}::shelves`;

/**
 * Last dashboard overview for this user and collection scope, so returning to
 * the dashboard paints immediately while fresh data loads.
 */
export function readDashboardCache(
  userId: string | undefined | null,
  scope: string,
): DashboardOverview | null {
  const uid = userId?.trim();
  return uid ? read<DashboardOverview>(overviewKey(uid, scope)) : null;
}

export function writeDashboardCache(
  userId: string | undefined | null,
  scope: string,
  data: DashboardOverview,
) {
  const uid = userId?.trim();
  if (uid) write(overviewKey(uid, scope), data);
}

/** Personal shelves are not collection-scoped: one entry per user. */
export function readShelvesCache(
  userId: string | undefined | null,
): DashboardShelfSummary[] | null {
  const uid = userId?.trim();
  return uid ? read<DashboardShelfSummary[]>(shelvesKey(uid)) : null;
}

export function writeShelvesCache(
  userId: string | undefined | null,
  shelves: DashboardShelfSummary[],
) {
  const uid = userId?.trim();
  if (uid) write(shelvesKey(uid), shelves);
}

export function clearDashboardCache() {
  memoryCache.clear();
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k &&
        [STORAGE_PREFIX, ...LEGACY_PREFIXES].some((prefix) =>
          k.startsWith(prefix),
        )
      ) {
        keysToDelete.push(k);
      }
    }
    for (const k of keysToDelete) localStorage.removeItem(k);
  } catch {
    // Ignore restricted storage contexts.
  }
}
