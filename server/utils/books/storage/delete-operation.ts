import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
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
import { copyVerifiedExclusive } from './verified-copy';

type DeleteJournal = {
  version: 1;
  id: string;
  bookId: string;
  sources: string[];
};
type Decision = {
  isCommitted: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
};

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function validate(root: string, journal: DeleteJournal): void {
  if (
    journal.version !== 1 ||
    typeof journal.id !== 'string' ||
    typeof journal.bookId !== 'string' ||
    !Array.isArray(journal.sources)
  )
    throw new Error('Invalid delete journal');
  for (const source of journal.sources) {
    if (typeof source !== 'string') throw new Error('Invalid delete source');
    const relative = path.relative(root, source);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error('Delete source escapes library');
  }
}
async function finish(
  root: string,
  dir: string,
  journal: DeleteJournal,
  decision: Decision,
): Promise<void> {
  validate(root, journal);
  if (await decision.isCommitted(journal.id)) {
    for (const [index, source] of journal.sources.entries()) {
      const backup = path.join(dir, String(index));
      let sourceStat;
      try {
        sourceStat = await stat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const backupStat = await stat(backup);
      if (
        sourceStat.size !== backupStat.size ||
        (await digest(source)) !== (await digest(backup))
      )
        throw new Error(`Delete source changed: ${source}`);
      await unlink(source);
    }
  }
  await rm(dir, { recursive: true });
  await decision.remove(journal.id);
}
export async function deleteStoredFiles(opts: {
  root: string;
  bookId: string;
  sources: string[];
  decision: Decision;
  commit: (id: string) => Promise<void>;
}): Promise<void> {
  const journal: DeleteJournal = {
    version: 1,
    id: randomUUID(),
    bookId: opts.bookId,
    sources: [...new Set(opts.sources)],
  };
  validate(opts.root, journal);
  const dir = path.join(opts.root, `.delb-delete-${journal.id}`);
  await mkdir(dir);
  await writeFile(path.join(dir, 'journal.json'), JSON.stringify(journal), {
    flag: 'wx',
  });
  const journalHandle = await open(path.join(dir, 'journal.json'), 'r');
  try {
    await journalHandle.sync();
  } finally {
    await journalHandle.close();
  }
  for (const [index, source] of journal.sources.entries()) {
    await copyVerifiedExclusive(source, path.join(dir, String(index)));
  }
  await opts.commit(journal.id);
  await finish(opts.root, dir, journal, opts.decision);
}
export async function recoverStoredDeletes(opts: {
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
  for (const name of names.filter((item) => item.startsWith('.delb-delete-'))) {
    const dir = path.join(opts.root, name);
    const journal = JSON.parse(
      await readFile(path.join(dir, 'journal.json'), 'utf8'),
    ) as DeleteJournal;
    validate(opts.root, journal);
    if (name !== `.delb-delete-${journal.id}`)
      throw new Error('Invalid delete journal identity');
    await opts.withLock(
      journal.bookId,
      async () => await finish(opts.root, dir, journal, opts.decision),
    );
  }
}
