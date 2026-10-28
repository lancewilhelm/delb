import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';

type JournalEntry = {
  targetPath: string;
  stagedName: string;
  backupName: string;
  hadOriginal: boolean;
};

type CoverUpdateJournal = {
  version: 1 | 2;
  operationId?: string;
  bookId?: string;
  phase: 'prepared' | 'database-committed';
  previousCoverImagePath: string | null;
  expectedCoverImagePath: string;
  entries: JournalEntry[];
};

export type CoverUpdateFile = {
  targetPath: string;
  data: Uint8Array;
};

export type CoverUpdateResult = {
  backupFallbackPaths: string[];
};

type RenameExistingToBackup = (
  source: string,
  destination: string,
) => Promise<void>;

export class CoverUpdateStorageError extends Error {
  readonly code = 'COVER_STORAGE_ERROR';
  readonly targetPath: string;

  constructor(targetPath: string, cause: unknown) {
    super(`Could not safely back up the existing file: ${targetPath}`, {
      cause,
    });
    this.name = 'CoverUpdateStorageError';
    this.targetPath = targetPath;
  }
}

export async function recoverPendingCoverUpdates(opts: {
  operationParent: string;
  allowedRoot: string;
  currentCoverImagePath: string | null;
  bookId?: string;
  decision?: {
    isCommitted: (id: string) => Promise<boolean>;
    remove: (id: string) => Promise<void>;
  };
}): Promise<CoverUpdateResult> {
  const backupFallbackPaths: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(opts.operationParent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { backupFallbackPaths };
    throw error;
  }
  for (const name of entries.filter((entry) =>
    entry.startsWith('.cover-update-'),
  )) {
    const operationDir = path.join(opts.operationParent, name);
    let journal: CoverUpdateJournal;
    try {
      journal = JSON.parse(
        await readFile(path.join(operationDir, 'journal.json'), 'utf8'),
      ) as CoverUpdateJournal;
      validateJournal(journal, opts.allowedRoot, operationDir);
      if (journal.version === 2 && journal.bookId !== opts.bookId) continue;
    } catch (error) {
      throw new Error(`Cannot recover cover journal ${operationDir}`, {
        cause: error,
      });
    }
    let committed: boolean;
    if (journal.version === 2) {
      if (!opts.decision || !journal.operationId)
        throw new Error(`Missing cover decision for ${operationDir}`);
      committed = await opts.decision.isCommitted(journal.operationId);
    } else if (journal.phase === 'database-committed') {
      committed = true;
    } else if (
      journal.previousCoverImagePath !== journal.expectedCoverImagePath &&
      opts.currentCoverImagePath === journal.previousCoverImagePath
    ) {
      committed = false;
    } else {
      throw new Error(`Ambiguous cover journal ${operationDir}`);
    }
    if (committed) {
      backupFallbackPaths.push(
        ...(await rollForward(operationDir, journal, rename)),
      );
    } else {
      await rollbackFiles(operationDir, journal);
    }
    await rm(operationDir, { recursive: true, force: true });
    if (journal.version === 2 && journal.operationId && opts.decision) {
      await opts.decision.remove(journal.operationId);
    }
  }
  return { backupFallbackPaths };
}

export async function commitCoverUpdate(opts: {
  operationParent: string;
  allowedRoot: string;
  previousCoverImagePath: string | null;
  expectedCoverImagePath: string;
  bookId?: string;
  files: CoverUpdateFile[];
  commitDatabase: (operationId: string) => Promise<void>;
  decision?: {
    isCommitted: (id: string) => Promise<boolean>;
    remove: (id: string) => Promise<void>;
  };
  rollbackDatabase: () => Promise<void>;
  renameExistingToBackup?: RenameExistingToBackup;
}): Promise<CoverUpdateResult> {
  const operationId = crypto.randomUUID();
  const operationDir = path.join(
    opts.operationParent,
    `.cover-update-${operationId}`,
  );
  await mkdir(operationDir, { recursive: false });
  const entries: JournalEntry[] = [];
  try {
    for (const [index, file] of opts.files.entries()) {
      assertInside(opts.allowedRoot, file.targetPath);
      const stagedName = `new-${index}`;
      const backupName = `old-${index}`;
      const hadOriginal = await exists(file.targetPath);
      await writeFile(path.join(operationDir, stagedName), file.data, {
        flag: 'wx',
      });
      entries.push({
        targetPath: file.targetPath,
        stagedName,
        backupName,
        hadOriginal,
      });
    }
    const journal: CoverUpdateJournal = {
      version: opts.decision ? 2 : 1,
      operationId: opts.decision ? operationId : undefined,
      bookId: opts.decision ? opts.bookId : undefined,
      phase: 'prepared',
      previousCoverImagePath: opts.previousCoverImagePath,
      expectedCoverImagePath: opts.expectedCoverImagePath,
      entries,
    };
    await writeJournal(operationDir, journal);
    await opts.commitDatabase(operationId);
    journal.phase = 'database-committed';
    await writeJournal(operationDir, journal);
    const backupFallbackPaths = await rollForward(
      operationDir,
      journal,
      opts.renameExistingToBackup ?? rename,
    );
    await rm(operationDir, { recursive: true, force: true });
    if (opts.decision) await opts.decision.remove(operationId);
    return { backupFallbackPaths };
  } catch (error) {
    if (opts.decision && (await opts.decision.isCommitted(operationId))) {
      throw error;
    }
    const journal: CoverUpdateJournal = {
      version: opts.decision ? 2 : 1,
      operationId: opts.decision ? operationId : undefined,
      bookId: opts.decision ? opts.bookId : undefined,
      phase: 'prepared',
      previousCoverImagePath: opts.previousCoverImagePath,
      expectedCoverImagePath: opts.expectedCoverImagePath,
      entries,
    };
    let filesRolledBack = false;
    try {
      await rollbackFiles(operationDir, journal);
      filesRolledBack = true;
    } catch {
      // Keep the operation directory and journal. It may contain the only
      // recoverable copy of an original file.
    }
    let databaseRolledBack = false;
    try {
      await opts.rollbackDatabase();
      databaseRolledBack = true;
    } catch {
      // Keep the journal and staged files. A later recovery pass can inspect the
      // persisted cover path and either finish or discard the operation.
    }
    if (
      filesRolledBack &&
      (databaseRolledBack ||
        opts.previousCoverImagePath === opts.expectedCoverImagePath)
    ) {
      await rm(operationDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function rollForward(
  operationDir: string,
  journal: CoverUpdateJournal,
  renameExistingToBackup: RenameExistingToBackup,
): Promise<string[]> {
  const backupFallbackPaths: string[] = [];
  for (const entry of journal.entries) {
    const staged = path.join(operationDir, entry.stagedName);
    const backup = path.join(operationDir, entry.backupName);
    if (!(await exists(staged))) continue;
    await mkdir(path.dirname(entry.targetPath), { recursive: true });
    if (
      entry.hadOriginal &&
      !(await exists(backup)) &&
      (await exists(entry.targetPath))
    ) {
      const usedFallback = await moveExistingToBackup(
        entry.targetPath,
        backup,
        renameExistingToBackup,
      );
      if (usedFallback) backupFallbackPaths.push(entry.targetPath);
    } else if (await exists(entry.targetPath)) {
      throw new Error(`Cover target unexpectedly exists: ${entry.targetPath}`);
    }
    await rename(staged, entry.targetPath);
  }
  return backupFallbackPaths;
}

async function moveExistingToBackup(
  source: string,
  backup: string,
  renameExistingToBackup: RenameExistingToBackup,
): Promise<boolean> {
  try {
    await renameExistingToBackup(source, backup);
    return false;
  } catch (renameError) {
    if (!isUnionFilesystemRenameError(renameError)) throw renameError;

    try {
      const sourceSize = (await stat(source)).size;
      const sourceHash = await sha256(source);
      await copyFile(source, backup, constants.COPYFILE_EXCL);
      const backupHandle = await open(backup, 'r');
      try {
        await backupHandle.sync();
      } finally {
        await backupHandle.close();
      }
      const backupSize = (await stat(backup)).size;
      const backupHash = await sha256(backup);
      if (sourceSize !== backupSize || sourceHash !== backupHash) {
        throw new Error('The verified backup did not match the original file');
      }
      await unlink(source);
      return true;
    } catch (fallbackError) {
      // The source is still present unless unlink succeeded. Never delete the
      // backup if it may now be the only recoverable copy.
      throw new CoverUpdateStorageError(
        source,
        new AggregateError(
          [renameError, fallbackError],
          'Rename and verified-copy backup both failed',
        ),
      );
    }
  }
}

function isUnionFilesystemRenameError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const fsError = error as NodeJS.ErrnoException;
  return (
    fsError.errno === -117 ||
    fsError.errno === -18 ||
    fsError.code === 'EUCLEAN' ||
    fsError.code === 'EXDEV'
  );
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function rollbackFiles(
  operationDir: string,
  journal: CoverUpdateJournal,
): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    const staged = path.join(operationDir, entry.stagedName);
    const backup = path.join(operationDir, entry.backupName);
    if (await exists(backup)) {
      if ((await exists(entry.targetPath)) && !(await exists(staged)))
        await rename(entry.targetPath, staged);
      else await unlink(entry.targetPath).catch(() => undefined);
      await rename(backup, entry.targetPath);
    } else if (!entry.hadOriginal && (await exists(entry.targetPath))) {
      if (!(await exists(staged))) await rename(entry.targetPath, staged);
      else await unlink(entry.targetPath).catch(() => undefined);
    }
  }
}

async function writeJournal(
  operationDir: string,
  journal: CoverUpdateJournal,
): Promise<void> {
  const temporary = path.join(operationDir, 'journal.tmp');
  await writeFile(temporary, JSON.stringify(journal), { flag: 'w' });
  await rename(temporary, path.join(operationDir, 'journal.json'));
}

function validateJournal(
  journal: CoverUpdateJournal,
  allowedRoot: string,
  operationDir: string,
): void {
  if (
    (journal.version !== 1 && journal.version !== 2) ||
    (journal.version === 2 &&
      (typeof journal.operationId !== 'string' ||
        typeof journal.bookId !== 'string')) ||
    !Array.isArray(journal.entries)
  )
    throw new Error('Invalid cover update journal');
  for (const entry of journal.entries) {
    assertInside(allowedRoot, entry.targetPath);
    assertInside(operationDir, path.join(operationDir, entry.stagedName));
    assertInside(operationDir, path.join(operationDir, entry.backupName));
  }
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes the allowed root: ${candidate}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
