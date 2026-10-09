import path from 'node:path';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
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
  version: 1;
  phase: 'prepared' | 'database-committed';
  previousCoverImagePath: string | null;
  expectedCoverImagePath: string;
  entries: JournalEntry[];
};

export type CoverUpdateFile = {
  targetPath: string;
  data: Uint8Array;
};

export async function recoverPendingCoverUpdates(opts: {
  operationParent: string;
  allowedRoot: string;
  currentCoverImagePath: string | null;
}): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(opts.operationParent);
  } catch {
    return;
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
    } catch {
      // Preserve an unreadable operation directory: it may contain the only
      // recoverable backups after an interrupted rename or disk failure.
      continue;
    }
    const databaseChanged =
      journal.previousCoverImagePath !== journal.expectedCoverImagePath &&
      opts.currentCoverImagePath === journal.expectedCoverImagePath;
    if (journal.phase === 'database-committed' || databaseChanged) {
      await rollForward(operationDir, journal);
    } else {
      await rollbackFiles(operationDir, journal);
    }
    await rm(operationDir, { recursive: true, force: true });
  }
}

export async function commitCoverUpdate(opts: {
  operationParent: string;
  allowedRoot: string;
  previousCoverImagePath: string | null;
  expectedCoverImagePath: string;
  files: CoverUpdateFile[];
  commitDatabase: () => Promise<void>;
  rollbackDatabase: () => Promise<void>;
}): Promise<void> {
  const operationDir = path.join(
    opts.operationParent,
    `.cover-update-${crypto.randomUUID()}`,
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
      version: 1,
      phase: 'prepared',
      previousCoverImagePath: opts.previousCoverImagePath,
      expectedCoverImagePath: opts.expectedCoverImagePath,
      entries,
    };
    await writeJournal(operationDir, journal);
    await opts.commitDatabase();
    journal.phase = 'database-committed';
    await writeJournal(operationDir, journal);
    await rollForward(operationDir, journal);
    await rm(operationDir, { recursive: true, force: true });
  } catch (error) {
    const journal: CoverUpdateJournal = {
      version: 1,
      phase: 'prepared',
      previousCoverImagePath: opts.previousCoverImagePath,
      expectedCoverImagePath: opts.expectedCoverImagePath,
      entries,
    };
    await rollbackFiles(operationDir, journal).catch(() => undefined);
    let databaseRolledBack = false;
    try {
      await opts.rollbackDatabase();
      databaseRolledBack = true;
    } catch {
      // Keep the journal and staged files. A later recovery pass can inspect the
      // persisted cover path and either finish or discard the operation.
    }
    if (
      databaseRolledBack ||
      opts.previousCoverImagePath === opts.expectedCoverImagePath
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
): Promise<void> {
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
      await rename(entry.targetPath, backup);
    } else if (await exists(entry.targetPath)) {
      await unlink(entry.targetPath);
    }
    await rename(staged, entry.targetPath);
  }
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
  if (journal.version !== 1 || !Array.isArray(journal.entries))
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
  } catch {
    return false;
  }
}
