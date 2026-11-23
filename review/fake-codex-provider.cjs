const fs = require('node:fs');
const { deflateSync } = require('node:zlib');

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
function createSolidRgbPng(width, height, r, g, b) {
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const original = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );
  if (url.hostname !== 'auth.openai.com' && url.hostname !== 'chatgpt.com')
    return original(input, options);
  if (url.pathname.endsWith('/usercode'))
    return Response.json({
      device_auth_id: 'synthetic-device',
      user_code: 'TEST-CODE',
      interval: 3,
    });
  if (url.pathname.endsWith('/deviceauth/token'))
    return Response.json({
      authorization_code: 'synthetic-code',
      code_verifier: 'synthetic-verifier',
    });
  if (url.pathname === '/oauth/token') {
    if (new URLSearchParams(options.body).get('grant_type') === 'refresh_token')
      fs.appendFileSync('review/demo/fake-codex-refreshes.txt', 'refresh\n');
    return Response.json({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      expires_in: 1,
    });
  }
  if (url.pathname.endsWith('/images/edits')) {
    const body = JSON.parse(options.body);
    fs.appendFileSync(
      'review/demo/fake-codex-calls.jsonl',
      JSON.stringify({
        prompt: body.prompt,
        images: body.images.length,
        size: body.size,
      }) + '\n',
    );
    if (body.prompt.includes('WAIT_FOR_PERMISSION'))
      await new Promise((resolve) => setTimeout(resolve, 1500));
    if (body.prompt.includes('FAIL_IMAGE'))
      return new Response('', { status: 429 });
    const image = createSolidRgbPng(180, 100, 0x67, 0x3e, 0x8a);
    return Response.json({ data: [{ b64_json: image.toString('base64') }] });
  }
  return new Response('', { status: 404 });
};
