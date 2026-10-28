export class UploadTooLargeError extends Error {}

export async function readBoundedUpload(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(Buffer.from(chunk));
  }
  if (tooLarge) throw new UploadTooLargeError('Upload exceeds size limit');
  return Buffer.concat(chunks, size);
}
