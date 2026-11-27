/**
 * Injects a PNG `pHYs` chunk so print applications know the exact physical
 * dimensions of an exported image (e.g., 50 × 30 mm at 12 or 24 px/mm).
 */

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function isPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function buildPhysChunk(
  pixelsPerMeterX: number,
  pixelsPerMeterY: number,
): Uint8Array {
  // 4-byte length + 4-byte type ("pHYs") + 9-byte payload + 4-byte CRC = 21 bytes
  const chunk = new Uint8Array(21);
  writeUint32BE(chunk, 0, 9);
  chunk[4] = 0x70; // 'p'
  chunk[5] = 0x48; // 'H'
  chunk[6] = 0x59; // 'Y'
  chunk[7] = 0x73; // 's'
  writeUint32BE(chunk, 8, Math.max(1, Math.round(pixelsPerMeterX)));
  writeUint32BE(chunk, 12, Math.max(1, Math.round(pixelsPerMeterY)));
  chunk[16] = 1; // unit specifier: meter
  const crc = crc32(chunk.subarray(4, 17));
  writeUint32BE(chunk, 17, crc);
  return chunk;
}

/**
 * Inserts (or replaces) a PNG `pHYs` chunk immediately after `IHDR`.
 * Returns the original bytes untouched if the buffer is not a valid PNG.
 */
export function injectPngPhys(
  pngBytes: Uint8Array,
  pixelsPerMeterX: number,
  pixelsPerMeterY = pixelsPerMeterX,
): Uint8Array {
  if (!isPngSignature(pngBytes)) return pngBytes;

  const chunks: Uint8Array[] = [];
  let offset = PNG_SIGNATURE.length;
  let inserted = false;
  const physChunk = buildPhysChunk(pixelsPerMeterX, pixelsPerMeterY);

  while (offset + 12 <= pngBytes.length) {
    const length = readUint32BE(pngBytes, offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > pngBytes.length) return pngBytes;

    const type = String.fromCharCode(
      pngBytes[offset + 4]!,
      pngBytes[offset + 5]!,
      pngBytes[offset + 6]!,
      pngBytes[offset + 7]!,
    );

    if (type !== 'pHYs') {
      chunks.push(pngBytes.subarray(offset, chunkEnd));
      if (type === 'IHDR' && !inserted) {
        chunks.push(physChunk);
        inserted = true;
      }
    }
    offset = chunkEnd;
  }

  if (!inserted) return pngBytes;

  let totalLength = PNG_SIGNATURE.length;
  for (const part of chunks) totalLength += part.length;

  const out = new Uint8Array(totalLength);
  out.set(PNG_SIGNATURE, 0);
  let cursor = PNG_SIGNATURE.length;
  for (const part of chunks) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

export async function canvasToPhysicalPngBlob(
  canvas: HTMLCanvasElement,
  pxPerMm: number,
): Promise<Blob> {
  const rawBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not export the mini cover as a PNG.'));
    }, 'image/png');
  });
  const buffer = new Uint8Array(await rawBlob.arrayBuffer());
  const withPhys = injectPngPhys(buffer, Math.round(pxPerMm * 1000));
  const arrayCopy = new Uint8Array(withPhys.byteLength);
  arrayCopy.set(withPhys);
  return new Blob([arrayCopy.buffer], { type: 'image/png' });
}

export function downloadPngBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
