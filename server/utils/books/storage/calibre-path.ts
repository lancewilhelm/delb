import path from 'node:path';
import { realpath } from 'node:fs/promises';

export async function confinedCalibrePath(
  root: string,
  candidate: string,
): Promise<string> {
  const realRoot = await realpath(root);
  const realCandidate = await realpath(path.resolve(root, candidate));
  const relative = path.relative(realRoot, realCandidate);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Calibre path escapes the configured library');
  }
  return realCandidate;
}
