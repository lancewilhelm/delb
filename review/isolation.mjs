import { readdir, access } from 'node:fs/promises';

export async function assertNoEnvironmentFiles() {
  const names = await readdir('.');
  if (
    names.some(
      (name) =>
        name === '.env' ||
        (name.startsWith('.env.') && name !== '.env.example'),
    )
  ) {
    throw new Error('Use a fresh review checkout without environment files');
  }
}

export async function assertEmptyStorage() {
  for (const directory of ['data', 'library', 'dropbox', 'calibre']) {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (names.some((name) => name !== '.gitkeep')) {
      throw new Error(
        `Use fresh disposable storage; ${directory} is not empty`,
      );
    }
  }
  try {
    await access('review/demo/synthetic.db');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(
    'A review database already exists; use a new disposable checkout',
  );
}
