import type {
  DashboardCounts,
  DashboardData,
  DashboardShelf,
} from '#shared/types/dashboard';

const STORAGE_PREFIX = 'delb.dashboardCache.v1:';
const MAX_ENTRIES = 24;

type CachedDashboardEntry = {
  counts: DashboardCounts;
  shelf: DashboardData['shelf'];
  cachedAt: number;
};

const memoryCache = new Map<string, CachedDashboardEntry>();
const countsCache = new Map<string, DashboardCounts>();

function cacheKey(userId: string, scope: string, shelf: DashboardShelf) {
  return `${userId}::${scope || 'all'}::${shelf}`;
}

function countsKey(userId: string, scope: string) {
  return `${userId}::${scope || 'all'}`;
}

function readStoredEntry(key: string): CachedDashboardEntry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedDashboardEntry | null;
    if (!parsed || !parsed.counts || !parsed.shelf) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredEntry(key: string, entry: CachedDashboardEntry) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(entry));
  } catch {
    // Ignore storage quota / private mode failures.
  }
}

export function readDashboardCache(
  userId: string | undefined | null,
  scope: string,
  shelf: DashboardShelf,
): {
  counts: DashboardCounts | null;
  shelf: DashboardData['shelf'] | null;
} {
  const uid = userId?.trim();
  if (!uid) return { counts: null, shelf: null };

  const key = cacheKey(uid, scope, shelf);
  let entry = memoryCache.get(key) ?? null;
  if (!entry) {
    entry = readStoredEntry(key);
    if (entry) {
      memoryCache.set(key, entry);
      countsCache.set(countsKey(uid, scope), entry.counts);
    }
  }
  if (entry) {
    return {
      counts: { ...entry.counts },
      shelf: {
        ...entry.shelf,
        books: entry.shelf.books.map((book) => ({ ...book })),
      },
    };
  }

  // Fallback: even when switching to a shelf tab we haven't opened yet,
  // reuse the scope's already-known counts so the stat bar never flashes "—".
  const existingCounts = countsCache.get(countsKey(uid, scope));
  if (existingCounts) {
    return { counts: { ...existingCounts }, shelf: null };
  }

  // Also check other shelf entries in localStorage for this user+scope.
  for (const fallbackShelf of ['reading', 'finished', 'tbr'] as const) {
    if (fallbackShelf === shelf) continue;
    const other = readStoredEntry(cacheKey(uid, scope, fallbackShelf));
    if (other) {
      countsCache.set(countsKey(uid, scope), other.counts);
      return { counts: { ...other.counts }, shelf: null };
    }
  }

  return { counts: null, shelf: null };
}

export function writeDashboardCache(
  userId: string | undefined | null,
  scope: string,
  shelf: DashboardShelf,
  data: DashboardData,
) {
  const uid = userId?.trim();
  if (!uid) return;

  const entry: CachedDashboardEntry = {
    counts: { ...data.counts },
    shelf: {
      ...data.shelf,
      books: data.shelf.books.map((book) => ({ ...book })),
    },
    cachedAt: Date.now(),
  };

  const key = cacheKey(uid, scope, shelf);
  if (memoryCache.has(key)) memoryCache.delete(key);
  memoryCache.set(key, entry);
  while (memoryCache.size > MAX_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
  countsCache.set(countsKey(uid, scope), entry.counts);
  writeStoredEntry(key, entry);
}

export function clearDashboardCache() {
  memoryCache.clear();
  countsCache.clear();
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) {
        keysToDelete.push(k);
      }
    }
    for (const k of keysToDelete) {
      localStorage.removeItem(k);
    }
  } catch {
    // Ignore restricted storage contexts.
  }
}
