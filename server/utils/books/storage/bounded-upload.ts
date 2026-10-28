import { IncomingMessage, type ServerResponse } from 'node:http';

export class UploadTooLargeError extends Error {
  readonly statusCode = 413;
  get statusMessage() {
    return this.message;
  }
}
export class UploadTimeoutError extends Error {
  readonly statusCode = 408;
  get statusMessage() {
    return this.message;
  }
}

export async function readBoundedUpload(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
  timeoutMs = 120_000,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator =
    stream instanceof IncomingMessage
      ? stream.iterator({ destroyOnReturn: false })
      : stream[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UploadTimeoutError('Upload timed out')),
      timeoutMs,
    );
  });
  try {
    while (true) {
      const item = await Promise.race([iterator.next(), deadline]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit)
        throw new UploadTooLargeError('Upload exceeds size limit');
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    void iterator.return?.().catch(() => undefined);
  }
}

export async function cacheBoundedRequestBody(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number,
  timeoutMs = 120_000,
): Promise<void> {
  try {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > limit)
      throw new UploadTooLargeError('Upload exceeds size limit');
    const rawBody = await readBoundedUpload(req, limit, timeoutMs);
    Object.assign(req, { rawBody });
  } catch (error) {
    if (
      error instanceof UploadTooLargeError ||
      error instanceof UploadTimeoutError
    ) {
      res.setHeader('Connection', 'close');
      req.resume();
      res.once('finish', () => req.destroy());
    }
    throw error;
  }
}
