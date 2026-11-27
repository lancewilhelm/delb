import assert from 'node:assert/strict';
import test from 'node:test';
import { injectPngPhys } from './pngPhys';

function makeMinimalPng(extraChunks: Uint8Array[] = []): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  // Minimal 13-byte IHDR chunk (length 13 + type + 13 data + 4 crc = 25 bytes)
  const ihdr = new Uint8Array(25);
  ihdr[3] = 13;
  ihdr.set([0x49, 0x48, 0x44, 0x52], 4); // IHDR
  // Minimal 0-byte IEND chunk (12 bytes)
  const iend = new Uint8Array([
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const parts = [sig, ihdr, ...extraChunks, iend];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.length;
  }
  return out;
}

function listChunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const result: { type: string; data: Uint8Array }[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset, 4);
    const len = view.getUint32(0, false);
    const type = String.fromCharCode(
      png[offset + 4]!,
      png[offset + 5]!,
      png[offset + 6]!,
      png[offset + 7]!,
    );
    const data = png.subarray(offset + 8, offset + 8 + len);
    result.push({ type, data });
    offset += 12 + len;
  }
  return result;
}

test('injectPngPhys inserts pHYs right after IHDR with exact pixels-per-meter', () => {
  const base = makeMinimalPng();
  const out = injectPngPhys(base, 24000);
  const chunks = listChunks(out);

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'pHYs', 'IEND'],
  );
  const phys = chunks[1]!.data;
  assert.equal(phys.length, 9);
  const view = new DataView(phys.buffer, phys.byteOffset, phys.byteLength);
  assert.equal(view.getUint32(0, false), 24000);
  assert.equal(view.getUint32(4, false), 24000);
  assert.equal(phys[8], 1); // meters
});

test('injectPngPhys replaces an existing pHYs chunk rather than duplicating it', () => {
  const first = injectPngPhys(makeMinimalPng(), 12000);
  const replaced = injectPngPhys(first, 24000);
  const chunks = listChunks(replaced);

  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'pHYs', 'IEND'],
  );
  const phys = chunks[1]!.data;
  const view = new DataView(phys.buffer, phys.byteOffset, phys.byteLength);
  assert.equal(view.getUint32(0, false), 24000);
});

test('injectPngPhys leaves non-PNG buffers untouched', () => {
  const invalid = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(injectPngPhys(invalid, 12000), invalid);
});
