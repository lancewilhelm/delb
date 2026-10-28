import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

type Journal = {
  version: 1;
  id: string;
  bookId: string;
  directory: string;
  file: string;
};
type Decision = {
  isCommitted: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
};
function validate(root: string, journal: Journal): void {
  if (
    journal.version !== 1 ||
    typeof journal.id !== 'string' ||
    typeof journal.bookId !== 'string' ||
    typeof journal.directory !== 'string' ||
    typeof journal.file !== 'string'
  )
    throw new Error('Invalid creation journal');
  for (const candidate of [journal.directory, journal.file]) {
    const relative = path.relative(root, candidate);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error('Creation path escapes library');
  }
  if (path.dirname(journal.file) !== journal.directory)
    throw new Error('Invalid creation file path');
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
  journalDir: string,
  journal: Journal,
  decision: Decision,
): Promise<void> {
  validate(root, journal);
  if (await decision.isCommitted(journal.id)) {
    if (!(await exists(journal.file)))
      throw new Error(`Committed upload is missing: ${journal.file}`);
    await rm(journalDir, { recursive: true });
    await decision.remove(journal.id);
    return;
  }
  const failedDir = path.join(root, `.delb-failed-create-${journal.id}`);
  try {
    await mkdir(failedDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const names = await readdir(failedDir);
  if (names.some((name) => name !== 'files'))
    throw new Error(`Unexpected creation recovery directory: ${failedDir}`);
  const recovered = path.join(failedDir, 'files');
  const sourceExists = await exists(journal.directory);
  const recoveredExists = await exists(recovered);
  if (sourceExists && recoveredExists)
    throw new Error(`Conflicting creation recovery: ${failedDir}`);
  if (sourceExists) await rename(journal.directory, recovered);
  else if (!recoveredExists)
    throw new Error(`Creation input is missing: ${journal.directory}`);
  await rename(journalDir, path.join(failedDir, 'journal'));
}
export async function beginStoredCreate(opts: {
  root: string;
  bookId: string;
  directory: string;
  file: string;
  decision: Decision;
}): Promise<{ id: string; finish: () => Promise<void> }> {
  const journal: Journal = {
    version: 1,
    id: randomUUID(),
    bookId: opts.bookId,
    directory: opts.directory,
    file: opts.file,
  };
  validate(opts.root, journal);
  await mkdir(path.dirname(journal.directory), { recursive: true });
  await mkdir(journal.directory);
  const dir = path.join(opts.root, `.delb-create-${journal.id}`);
  const preparing = path.join(
    opts.root,
    `.delb-preparing-create-${journal.id}`,
  );
  await mkdir(preparing);
  const file = path.join(preparing, 'journal.json');
  await writeFile(file, JSON.stringify(journal), { flag: 'wx' });
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(preparing, dir);
  return {
    id: journal.id,
    finish: async () => {
      if (await exists(dir))
        await finish(opts.root, dir, journal, opts.decision);
    },
  };
}
export async function recoverStoredCreates(opts: {
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
  for (const name of names.filter((item) => item.startsWith('.delb-create-'))) {
    const dir = path.join(opts.root, name);
    let journal: Journal;
    try {
      journal = JSON.parse(
        await readFile(path.join(dir, 'journal.json'), 'utf8'),
      ) as Journal;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        !(await existsDirectory(dir))
      )
        continue;
      throw error;
    }
    validate(opts.root, journal);
    if (name !== `.delb-create-${journal.id}`)
      throw new Error('Invalid creation journal identity');
    await opts.withLock(journal.bookId, async () => {
      if (await exists(dir))
        await finish(opts.root, dir, journal, opts.decision);
    });
  }
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
