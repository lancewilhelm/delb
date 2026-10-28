import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseEpubMetadataFromBuffer } from './epub';
import { extractAndStoreEpubCover } from './epub-cover';

function oversizedArchiveDirectory(): Buffer {
  const bytes = Buffer.alloc(69);
  bytes.writeUInt32LE(0x02014b50, 0);
  bytes.writeUInt32LE(32 * 1024 * 1024 + 1, 24);
  bytes.writeUInt16LE(1, 28);
  bytes[46] = 97;
  bytes.writeUInt32LE(0x06054b50, 47);
  bytes.writeUInt16LE(1, 57);
  return bytes;
}

test('metadata and cover extraction reject oversized archive entries before parsing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delb-epub-limit-'));
  const input = path.join(root, 'input.epub');
  const output = path.join(root, 'output');
  const bytes = oversizedArchiveDirectory();
  try {
    await writeFile(input, bytes);
    await assert.rejects(parseEpubMetadataFromBuffer(bytes), {
      code: 'ARCHIVE_LIMIT_EXCEEDED',
    });
    await assert.rejects(
      extractAndStoreEpubCover({
        epubFilePath: input,
        outputDirAbsolute: output,
        outputThumbRelativePathPosix: 'library/book/thumb.webp',
        outputSourceRelativePathPosix: 'library/book/source.bin',
      }),
      { code: 'ARCHIVE_LIMIT_EXCEEDED' },
    );
    assert.deepEqual(await readdir(root), ['input.epub']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('epub2 inflater rejects output larger than zero or underreported ZIP sizes', async () => {
  const { createRequire } = await import('node:module');
  const { deflateRawSync } = await import('node:zlib');
  const require = createRequire(import.meta.url);
  const epubRequire = createRequire(require.resolve('epub2'));
  const AdmZip = epubRequire('adm-zip');
  for (const declared of [0, 1]) {
    const name = Buffer.from('a');
    const compressed = deflateRawSync(Buffer.alloc(1024, 65));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + compressed.length, 16);
    const entry = new AdmZip(
      Buffer.concat([local, name, compressed, central, name, end]),
    ).getEntry('a');
    assert.throws(() => entry.getData());
    const error = await new Promise((resolve) =>
      entry.getDataAsync((_data: Buffer, err: unknown) => resolve(err)),
    );
    assert.ok(error, `async inflate must reject declared size ${declared}`);
  }
});
