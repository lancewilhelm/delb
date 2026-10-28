import { createReadStream } from 'node:fs';
import { readBoundedUpload } from './bounded-upload';

export async function readBoundedFile(
  path: string,
  limit: number,
): Promise<Buffer> {
  const stream = createReadStream(path);
  try {
    return await readBoundedUpload(stream, limit);
  } finally {
    stream.destroy();
  }
}
