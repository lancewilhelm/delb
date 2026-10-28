import assert from 'node:assert/strict';
import test from 'node:test';
import { readBoundedUpload, UploadTooLargeError } from './bounded-upload';

test('limits a streamed request without retaining excess chunks', async () => {
  let consumed = 0;
  async function* stream() {
    for (const chunk of ['abc', 'def', 'ghi']) {
      consumed++;
      yield Buffer.from(chunk);
    }
  }
  await assert.rejects(readBoundedUpload(stream(), 5), UploadTooLargeError);
  assert.equal(consumed, 3);
  assert.equal((await readBoundedUpload(stream(), 9)).toString(), 'abcdefghi');
});
