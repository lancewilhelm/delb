import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { copyVerifiedExclusive, sameFileContents } from './verified-copy';

type MoveEntry = { source: string; destination: string };
type MoveJournal = {
  version: 1;
  id: string;
  bookId: string;
  entries: MoveEntry[];
};
type Decision = {
  isCommitted: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
};

function validate(root: string, journal: MoveJournal): void {
  if (
    journal.version !== 1 ||
    typeof journal.id !== 'string' ||
    typeof journal.bookId !== 'string' ||
    !Array.isArray(journal.entries)
  )
    throw new Error('Invalid move journal');
  for (const entry of journal.entries) {
    for (const file of [entry.source, entry.destination]) {
      if (typeof file !== 'string') throw new Error('Invalid move path');
      const relative = path.relative(root, file);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error('Move path escapes library');
    }
  }
  if (
    new Set(journal.entries.map((entry) => entry.destination)).size !==
    journal.entries.length
  )
    throw new Error('Multiple files have the same move destination');
}
async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function finish(
  root: string,
  dir: string,
  journal: MoveJournal,
  decision: Decision,
): Promise<void> {
  validate(root, journal);
  if (await decision.isCommitted(journal.id)) {
    for (const { source, destination } of journal.entries) {
      if (!(await exists(destination)))
        throw new Error(
          `Committed move destination is missing: ${destination}`,
        );
      if (!(await exists(source))) continue;
      if (!(await sameFileContents(source, destination)))
        throw new Error(`Moved file changed: ${source}`);
      await unlink(source);
    }
  } else {
    for (const { destination } of journal.entries) {
      if (await exists(destination))
        throw new Error(`Uncommitted move requires inspection: ${dir}`);
    }
  }
  await rm(dir, { recursive: true });
  await decision.remove(journal.id);
}
export async function moveStoredFiles(opts: {
  root: string;
  bookId: string;
  entries: MoveEntry[];
  decision: Decision;
  commit: (id: string) => Promise<void>;
}): Promise<void> {
  const journal: MoveJournal = {
    version: 1,
    id: randomUUID(),
    bookId: opts.bookId,
    entries: opts.entries,
  };
  validate(opts.root, journal);
  for (const entry of journal.entries) {
    if (await exists(entry.destination))
      throw new Error(`Move destination already exists: ${entry.destination}`);
  }
  const dir = path.join(opts.root, `.delb-move-${journal.id}`);
  await mkdir(dir);
  const journalFile = path.join(dir, 'journal.json');
  await writeFile(journalFile, JSON.stringify(journal), { flag: 'wx' });
  const handle = await open(journalFile, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (const entry of journal.entries) {
    await mkdir(path.dirname(entry.destination), { recursive: true });
    await copyVerifiedExclusive(entry.source, entry.destination);
  }
  await opts.commit(journal.id);
  await finish(opts.root, dir, journal, opts.decision);
}
export async function recoverStoredMoves(opts: {
  root: string;
  decision: Decision;
  withLock: (bookId: string, work: () => Promise<void>) => Promise<void>;
}): Promise<void> {
  let names: string[];
  try {
    names = await readdir(opts.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names.filter((item) => item.startsWith('.delb-move-'))) {
    const dir = path.join(opts.root, name);
    const journal = JSON.parse(
      await readFile(path.join(dir, 'journal.json'), 'utf8'),
    ) as MoveJournal;
    validate(opts.root, journal);
    if (name !== `.delb-move-${journal.id}`)
      throw new Error('Invalid move journal identity');
    await opts.withLock(
      journal.bookId,
      async () => await finish(opts.root, dir, journal, opts.decision),
    );
  }
}
