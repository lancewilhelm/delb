import path from 'node:path';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';

import { logger } from '~/utils/logger';

import {
  getDropboxIngestConfigFromSettings,
  type DropboxIngestConfig,
} from './config';
import { ingestDropboxFile } from './ingest';
import { resolveDropboxTarget, type DropboxTarget } from './target';
import { getGlobalSettingsRow } from './settings';

type SeenFile = {
  size: number;
  mtimeMs: number;
  stablePasses: number;
  lastSeenAt: number;
};

type DropboxWatcherState = {
  stop: () => Promise<void>;
};

const GLOBAL_KEY = '__delb_dropbox_watcher__';

function getExtLower(filename: string): string {
  return path.extname(filename || '').toLowerCase();
}

function timestampForFilename(d = new Date()): string {
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}

async function ensureDirs(cfg: DropboxIngestConfig) {
  await mkdir(cfg.dropboxDirAbs, { recursive: true });
  await mkdir(cfg.failedDirAbs, { recursive: true });
}

async function moveToFailed(opts: {
  failedDirAbs: string;
  fileAbs: string;
  originalFilename: string;
  reason: string;
}) {
  await mkdir(opts.failedDirAbs, { recursive: true });

  const ext = path.extname(opts.originalFilename);
  const base = path.basename(opts.originalFilename, ext);
  const failedName = `${base}.${timestampForFilename()}${ext || ''}`;
  const dest = path.join(opts.failedDirAbs, failedName);

  try {
    await rename(opts.fileAbs, dest);
  } catch {
    // best-effort; if rename fails, we leave the file where it is to avoid data loss
    return;
  }

  try {
    await writeFile(`${dest}.error.txt`, `${opts.reason}\n`, 'utf8');
  } catch {
    // ignore
  }
}

export function startDropboxIngestWatcher(): DropboxWatcherState {
  const existing = (globalThis as Record<string, unknown>)[
    GLOBAL_KEY
  ] as DropboxWatcherState | null;
  if (existing) return existing;

  const seen = new Map<string, SeenFile>();
  let scanning = false;
  let targetPromise: Promise<DropboxTarget> | null = null;
  let stopRequested = false;
  let timer: NodeJS.Timeout | null = null;

  const settingsRefreshMs = 30_000;
  let lastSettingsRefreshAt = 0;
  let cachedSettings: unknown = null;

  async function refreshSettingsIfNeeded(): Promise<unknown> {
    const now = Date.now();
    if (cachedSettings && now - lastSettingsRefreshAt < settingsRefreshMs) {
      return cachedSettings;
    }

    const row = await getGlobalSettingsRow();
    cachedSettings = row?.settings ?? {};
    lastSettingsRefreshAt = now;
    // Re-resolve target periodically so admin settings changes take effect.
    targetPromise = null;
    return cachedSettings;
  }

  async function getCfg() {
    const settings = await refreshSettingsIfNeeded();
    return getDropboxIngestConfigFromSettings(settings);
  }

  async function getTarget(): Promise<DropboxTarget> {
    targetPromise ??= resolveDropboxTarget();
    return await targetPromise;
  }

  function noteSeen(
    cfg: Awaited<ReturnType<typeof getCfg>>,
    fileAbs: string,
    size: number,
    mtimeMs: number,
  ) {
    const prev = seen.get(fileAbs);
    const now = Date.now();
    if (!prev) {
      seen.set(fileAbs, { size, mtimeMs, stablePasses: 1, lastSeenAt: now });
      return false;
    }

    const stable = prev.size === size && prev.mtimeMs === mtimeMs;
    const stablePasses = stable ? prev.stablePasses + 1 : 1;

    seen.set(fileAbs, { size, mtimeMs, stablePasses, lastSeenAt: now });
    return stablePasses >= cfg.stablePassesRequired;
  }

  function pruneSeen(cfg: Awaited<ReturnType<typeof getCfg>>) {
    const now = Date.now();
    for (const [k, v] of seen) {
      if (now - v.lastSeenAt > cfg.stableMaxAgeMs) seen.delete(k);
    }
  }

  async function scanOnce() {
    if (scanning) return;
    scanning = true;

    try {
      const cfg = await getCfg();
      if (!cfg.enabled) return;

      await ensureDirs(cfg);

      const entries = await readdir(cfg.dropboxDirAbs, { withFileTypes: true });
      pruneSeen(cfg);

      const candidates = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter((name) => !name.startsWith('.'))
        .filter((name) => name !== '.gitkeep')
        .filter((name) => !name.includes('.delb-processing-'))
        .filter((name) => cfg.allowedExtensions.has(getExtLower(name)));

      const ready: Array<{ fileAbs: string; filename: string }> = [];

      for (const filename of candidates) {
        const fileAbs = path.join(cfg.dropboxDirAbs, filename);
        let st;
        try {
          st = await stat(fileAbs);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;

        const stableEnough = noteSeen(cfg, fileAbs, st.size, st.mtimeMs);
        if (!stableEnough) continue;

        ready.push({ fileAbs, filename });
      }

      if (!ready.length) return;

      const target = await getTarget();

      // Process sequentially to keep things simple and avoid locking issues.
      for (const r of ready) {
        const processingName = `${r.filename}.delb-processing-${crypto.randomUUID()}`;
        const processingAbs = path.join(cfg.dropboxDirAbs, processingName);

        try {
          await rename(r.fileAbs, processingAbs);
        } catch {
          // File disappeared or got picked up elsewhere; skip.
          continue;
        }

        try {
          const result = await ingestDropboxFile({
            fileAbs: processingAbs,
            originalFilename: r.filename,
            target,
          });
          logger.info(
            { bookId: result.bookId, relativePath: result.relativePath },
            'dropbox: ingested book',
          );
        } catch (err: unknown) {
          const msg =
            err && typeof err === 'object' && 'message' in err
              ? String((err as { message?: unknown }).message)
              : 'Failed to ingest';

          logger.error({ err, filename: r.filename }, 'dropbox: ingest failed');
          await moveToFailed({
            failedDirAbs: cfg.failedDirAbs,
            fileAbs: processingAbs,
            originalFilename: r.filename,
            reason: msg,
          });
        } finally {
          seen.delete(r.fileAbs);
          seen.delete(processingAbs);
        }
      }
    } finally {
      scanning = false;
    }
  }

  async function tick() {
    if (stopRequested) return;

    try {
      await scanOnce();
    } catch (e) {
      logger.error(e, 'dropbox: watcher tick failed');
    }

    const cfg = await getCfg();
    if (stopRequested) return;

    timer = setTimeout(() => void tick(), cfg.pollIntervalMs);
  }

  // Kick off the loop.
  void tick();

  const state: DropboxWatcherState = {
    stop: async () => {
      stopRequested = true;
      if (timer) clearTimeout(timer);
      (globalThis as Record<string, unknown>)[GLOBAL_KEY] = null;
    },
  };

  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = state;

  // Note: initial settings are loaded async on first tick; avoid blocking plugin init here.
  logger.info('dropbox: watcher started');

  return state;
}
