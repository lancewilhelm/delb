import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { validateArchiveLimits } from '../dist/index.js';

function archiveWithDeclaredSize(size) {
  const bytes = Buffer.from(zipSync({ 'chapter.txt': Buffer.alloc(1024, 65) }));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(central, -1);
  bytes.writeUInt32LE(size, central + 24);
  bytes.writeUInt32LE(size, 22);
  return bytes;
}

test('preflight rejects an entry over the configured absolute limit', () => {
  const bytes = archiveWithDeclaredSize(1024);
  assert.throws(
    () => validateArchiveLimits(bytes, { maxEntryUncompressedBytes: 512 }),
    { code: 'ARCHIVE_LIMIT_EXCEEDED' },
  );
});

test('preflight rejects aggregate expansion before decompression', () => {
  const bytes = zipSync({
    one: Buffer.alloc(1024, 65),
    two: Buffer.alloc(1024, 66),
  });
  assert.throws(
    () =>
      validateArchiveLimits(bytes, {
        maxEntryUncompressedBytes: 1024,
        maxTotalUncompressedBytes: 1500,
      }),
    { code: 'ARCHIVE_LIMIT_EXCEEDED' },
  );
});
