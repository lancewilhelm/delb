import { unlink } from 'node:fs/promises';
import { sameFileContents } from '../storage/verified-copy';

export async function finishCommittedDropboxClaim(opts: {
  input: string;
  destination: string;
  removeDecision: () => Promise<void>;
}): Promise<void> {
  if (!(await sameFileContents(opts.input, opts.destination))) {
    throw new Error(`Dropbox committed copy cannot be verified: ${opts.input}`);
  }
  await unlink(opts.input);
  await opts.removeDecision();
}
