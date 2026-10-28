import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, open, stat } from 'node:fs/promises';

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function copyVerifiedExclusive(
  source: string,
  destination: string,
): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const handle = await open(destination, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const [sourceStat, destinationStat, sourceHash, destinationHash] =
    await Promise.all([
      stat(source),
      stat(destination),
      digest(source),
      digest(destination),
    ]);
  if (
    sourceStat.size !== destinationStat.size ||
    sourceHash !== destinationHash
  ) {
    throw new Error(`Copy verification failed for ${source}`);
  }
}
