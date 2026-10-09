import { deflateSync, unzipSync } from 'fflate';
import { EpubError, invalidEpub } from './errors.js';
import { normalizeArchivePath } from './path.js';
import type { ArchiveLimits } from './types.js';

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function readArchive(
  input: Uint8Array,
  overrides?: Partial<ArchiveLimits>,
): Map<string, Uint8Array> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  try {
    preflightArchive(input, limits);
  } catch (cause) {
    if (cause instanceof EpubError) throw cause;
    throw invalidEpub('The EPUB ZIP directory is malformed', cause);
  }
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(input);
  } catch (cause) {
    throw invalidEpub(
      'The input is not a readable ZIP-based EPUB archive',
      cause,
    );
  }

  const files = new Map<string, Uint8Array>();
  let actualTotal = 0;
  for (const [rawName, data] of Object.entries(raw)) {
    if (rawName.endsWith('/')) continue;
    const name = normalizeArchivePath(rawName);
    if (files.has(name))
      throw invalidEpub(`Duplicate EPUB archive path: ${name}`);
    if (data.length > limits.maxEntryUncompressedBytes) {
      throw new EpubError(
        'ARCHIVE_LIMIT_EXCEEDED',
        `${name} exceeds the per-entry uncompressed size limit`,
      );
    }
    actualTotal += data.length;
    if (actualTotal > limits.maxTotalUncompressedBytes) {
      throw new EpubError(
        'ARCHIVE_LIMIT_EXCEEDED',
        'EPUB exceeds the total uncompressed size limit',
      );
    }
    files.set(name, data);
  }
  return files;
}

function preflightArchive(input: Uint8Array, limits: ArchiveLimits): void {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const eocd = findSignature(
    view,
    0x06054b50,
    Math.max(0, input.byteLength - 65_557),
  );
  if (eocd < 0)
    throw invalidEpub('ZIP end-of-central-directory record was not found');

  let entryCount = view.getUint16(eocd + 10, true);
  let centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    const locatorOffset = eocd - 20;
    if (
      locatorOffset < 0 ||
      view.getUint32(locatorOffset, true) !== 0x07064b50
    ) {
      throw invalidEpub('ZIP64 locator is missing');
    }
    const zip64Offset = safeNumber(
      view.getBigUint64(locatorOffset + 8, true),
      'ZIP64 directory offset',
    );
    if (view.getUint32(zip64Offset, true) !== 0x06064b50)
      throw invalidEpub('ZIP64 directory record is missing');
    entryCount = safeNumber(
      view.getBigUint64(zip64Offset + 32, true),
      'ZIP64 entry count',
    );
    centralOffset = safeNumber(
      view.getBigUint64(zip64Offset + 48, true),
      'ZIP64 central directory offset',
    );
  }

  if (entryCount > limits.maxEntries) {
    throw new EpubError(
      'ARCHIVE_LIMIT_EXCEEDED',
      `EPUB contains ${entryCount} entries; the limit is ${limits.maxEntries}`,
    );
  }

  let offset = centralOffset;
  let total = 0;
  const names = new Set<string>();
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > input.byteLength ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw invalidEpub('ZIP central directory is malformed');
    }
    const method = view.getUint16(offset + 10, true);
    if (method !== 0 && method !== 8)
      throw invalidEpub(
        `EPUB uses unsupported ZIP compression method ${method}`,
      );
    let compressed = view.getUint32(offset + 20, true);
    let uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const extraStart = nameStart + nameLength;
    if (extraStart + extraLength + commentLength > input.byteLength)
      throw invalidEpub('ZIP entry exceeds the archive bounds');

    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      const zip64 = findExtraField(view, extraStart, extraLength, 0x0001);
      if (!zip64) throw invalidEpub('ZIP64 entry sizes are missing');
      let cursor = zip64.offset;
      if (uncompressed === 0xffffffff) {
        uncompressed = safeNumber(
          view.getBigUint64(cursor, true),
          'ZIP64 uncompressed size',
        );
        cursor += 8;
      }
      if (compressed === 0xffffffff)
        compressed = safeNumber(
          view.getBigUint64(cursor, true),
          'ZIP64 compressed size',
        );
    }

    const rawName = decoder.decode(
      input.subarray(nameStart, nameStart + nameLength),
    );
    if (!rawName.endsWith('/')) {
      const name = normalizeArchivePath(rawName);
      if (names.has(name))
        throw invalidEpub(`Duplicate EPUB archive path: ${name}`);
      names.add(name);
      if (uncompressed > limits.maxEntryUncompressedBytes) {
        throw new EpubError(
          'ARCHIVE_LIMIT_EXCEEDED',
          `${name} exceeds the per-entry uncompressed size limit`,
        );
      }
      total += uncompressed;
      if (total > limits.maxTotalUncompressedBytes) {
        throw new EpubError(
          'ARCHIVE_LIMIT_EXCEEDED',
          'EPUB exceeds the total uncompressed size limit',
        );
      }
    }
    offset = extraStart + extraLength + commentLength;
  }
}

function findSignature(
  view: DataView,
  signature: number,
  minimum: number,
): number {
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
}

function findExtraField(
  view: DataView,
  start: number,
  length: number,
  wantedId: number,
): { offset: number; length: number } | undefined {
  let cursor = start;
  const end = start + length;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    cursor += 4;
    if (cursor + size > end) throw invalidEpub('ZIP extra field is malformed');
    if (id === wantedId) return { offset: cursor, length: size };
    cursor += size;
  }
  return undefined;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw invalidEpub(`${label} is too large`);
  return Number(value);
}

export function writeArchive(files: Map<string, Uint8Array>): Uint8Array {
  const mimetype = files.get('mimetype');
  if (!mimetype || decoder.decode(mimetype) !== 'application/epub+zip') {
    throw invalidEpub(
      'EPUB mimetype must contain exactly application/epub+zip',
    );
  }
  const ordered = [
    ['mimetype', mimetype] as const,
    ...[...files.entries()]
      .filter(([name]) => name !== 'mimetype')
      .sort(([left], [right]) => left.localeCompare(right)),
  ];
  if (ordered.length > 0xffff)
    throw invalidEpub('Writing ZIP64 EPUBs is not supported');

  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;
  for (const [name, original] of ordered) {
    const normalized = normalizeArchivePath(name);
    const nameBytes = encoder.encode(normalized);
    const stored = normalized === 'mimetype';
    const compressed = stored ? original : deflateSync(original, { level: 6 });
    const crc = crc32(original);
    if (
      [original.length, compressed.length, localOffset].some(
        (value) => value > 0xffffffff,
      )
    ) {
      throw invalidEpub('Writing ZIP64 EPUBs is not supported');
    }

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, stored ? 10 : 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, stored ? 0 : 8, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x0021, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, original.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    localChunks.push(local, compressed);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, stored ? 10 : 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, stored ? 0 : 8, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, original.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centralChunks.push(central);
    localOffset += local.length + compressed.length;
  }

  const centralSize = centralChunks.reduce(
    (sum, chunk) => sum + chunk.length,
    0,
  );
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, ordered.length, true);
  ev.setUint16(10, ordered.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, localOffset, true);
  return concatenate([...localChunks, ...centralChunks, end]);
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of data)
    crc = CRC_TABLE[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
