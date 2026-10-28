import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readBoundedUpload,
  cacheBoundedRequestBody,
  UploadTooLargeError,
  UploadTimeoutError,
} from './bounded-upload';

test('limits a streamed request without retaining excess chunks', async () => {
  let consumed = 0;
  async function* stream() {
    for (const chunk of ['abc', 'def', 'ghi']) {
      consumed++;
      yield Buffer.from(chunk);
    }
  }
  await assert.rejects(readBoundedUpload(stream(), 5), UploadTooLargeError);
  assert.equal(consumed, 2);
  assert.equal((await readBoundedUpload(stream(), 9)).toString(), 'abcdefghi');
});

test('times out a stalled input instead of keeping a request open', async () => {
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => {}) };
    },
  };
  await assert.rejects(readBoundedUpload(stream, 5, 10), UploadTimeoutError);
});

test('HTTP rejection returns a status before an oversized or stalled request ends', async (t) => {
  const { createServer, request } = await import('node:http');
  const server = createServer(async (req, res) => {
    try {
      await cacheBoundedRequestBody(req, res, 5, 25);
      res.end('ok');
    } catch (error) {
      res.writeHead(error instanceof UploadTooLargeError ? 413 : 408);
      res.end('rejected');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  for (const [body, expected] of [
    ['abcdef', 413],
    ['a', 408],
  ] as const) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: address.port,
          method: 'POST',
          signal: AbortSignal.timeout(1000),
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write(body);
    });
    assert.equal(status, expected);
  }
});
