import { randomUUID } from 'node:crypto';
import {
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
import path from 'node:path';
import { copyVerifiedExclusive, sameFileContents } from './verified-copy';

type MoveEntry = { source: string; destination: string };
type MoveRecoveryWarning = {
  journalDir: string;
  marker: string;
  entries: MoveEntry[];
};
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
): Promise<MoveRecoveryWarning | undefined> {
  validate(root, journal);
  const marker = path.join(root, `.delb-failed-move-${journal.id}`);
  const committed = await decision.isCommitted(journal.id);
  if (await exists(marker)) {
    if (committed)
      throw new Error(`Committed move has a failed recovery marker: ${marker}`);
    const contents = await readFile(marker, 'utf8');
    if (contents.startsWith('retained-v1:')) {
      const destinations = contents.slice('retained-v1:'.length);
      if (
        !/^[01]*$/.test(destinations) ||
        destinations.length !== journal.entries.length
      )
        throw new Error(`Invalid move recovery marker: ${marker}`);
      for (let index = 0; index < journal.entries.length; index++) {
        if (!(await exists(path.join(dir, `retained-source-${index}`))))
          throw new Error(`Retained move source is missing: ${dir}`);
        if (
          destinations[index] === '1' &&
          !(await exists(path.join(dir, `retained-destination-${index}`)))
        )
          throw new Error(`Retained move destination is missing: ${dir}`);
      }
      return { journalDir: dir, marker, entries: journal.entries };
    }
    if (contents !== '')
      throw new Error(`Invalid move recovery marker: ${marker}`);
    await retainConflict(dir, marker, journal);
    return { journalDir: dir, marker, entries: journal.entries };
  }
  if (!committed) {
    for (const { source } of journal.entries) {
      if (!(await exists(source)))
        throw new Error(`Uncommitted move source is missing: ${source}`);
    }
  }
  if (committed) {
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
    for (const { source, destination } of journal.entries) {
      if (!(await exists(destination))) continue;
      if (!(await sameFileContents(source, destination))) {
        await retainConflict(dir, marker, journal);
        return { journalDir: dir, marker, entries: journal.entries };
      }
      await unlink(destination);
    }
  }
  await rm(dir, { recursive: true });
  await decision.remove(journal.id);
}
async function retainConflict(
  dir: string,
  marker: string,
  journal: MoveJournal,
): Promise<void> {
  let destinations = '';
  for (const [index, entry] of journal.entries.entries()) {
    for (const [kind, source] of [
      ['source', entry.source],
      ['destination', entry.destination],
    ] as const) {
      const present = await exists(source);
      if (kind === 'destination') destinations += present ? '1' : '0';
      if (!present) {
        if (kind === 'source')
          throw new Error(`Uncommitted move source is missing: ${source}`);
        continue;
      }
      const retained = path.join(dir, `retained-${kind}-${index}`);
      if (await exists(retained)) {
        if (!(await sameFileContents(source, retained)))
          throw new Error(`Retained move copy changed: ${retained}`);
        continue;
      }
      const temporary = path.join(dir, `copy-${randomUUID()}`);
      try {
        await copyVerifiedExclusive(source, temporary);
        await rename(temporary, retained);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  const temporary = path.join(dir, `marker-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`retained-v1:${destinations}`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, marker);
  } finally {
    await rm(temporary, { force: true });
  }
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
  const preparing = path.join(opts.root, `.delb-preparing-move-${journal.id}`);
  await mkdir(preparing);
  const journalFile = path.join(preparing, 'journal.json');
  await writeFile(journalFile, JSON.stringify(journal), { flag: 'wx' });
  const handle = await open(journalFile, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(preparing, dir);
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
}): Promise<MoveRecoveryWarning[]> {
  const warnings: MoveRecoveryWarning[] = [];
  let names: string[];
  try {
    names = await readdir(opts.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return warnings;
    throw error;
  }
  for (const name of names.filter((item) => item.startsWith('.delb-move-'))) {
    const dir = path.join(opts.root, name);
    let journal: MoveJournal;
    try {
      journal = JSON.parse(
        await readFile(path.join(dir, 'journal.json'), 'utf8'),
      ) as MoveJournal;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        !(await existsDirectory(dir))
      )
        continue;
      throw error;
    }
    validate(opts.root, journal);
    if (name !== `.delb-move-${journal.id}`)
      throw new Error('Invalid move journal identity');
    await opts.withLock(journal.bookId, async () => {
      if (await exists(dir)) {
        const warning = await finish(opts.root, dir, journal, opts.decision);
        if (warning) warnings.push(warning);
      }
    });
  }
  return warnings;
}

async function existsDirectory(dir: string): Promise<boolean> {
  try {
    await stat(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
