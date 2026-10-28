import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { copyVerifiedExclusive } from '../storage/verified-copy';

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

export async function moveToFailed(opts: {
  failedDirAbs: string;
  fileAbs: string;
  originalFilename: string;
  reason: string;
  now?: Date;
}) {
  await mkdir(opts.failedDirAbs, { recursive: true });

  const ext = path.extname(opts.originalFilename);
  const base = path.basename(opts.originalFilename, ext);
  const failedName = `${base}.${timestampForFilename(opts.now)}.${crypto.randomUUID()}${ext || ''}`;
  const dest = path.join(opts.failedDirAbs, failedName);

  try {
    await copyVerifiedExclusive(opts.fileAbs, dest);
    await unlink(opts.fileAbs);
  } catch {
    // Keep the claim if the failed destination cannot be safely created.
    return;
  }

  try {
    await writeFile(`${dest}.error.txt`, `${opts.reason}\n`, 'utf8');
  } catch {
    // ignore
  }
}
