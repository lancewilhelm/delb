const fs = require('node:fs');
const sharp = require('sharp');
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
    const image = await sharp({
      create: { width: 180, height: 100, channels: 3, background: '#673e8a' },
    })
      .png()
      .toBuffer();
    return Response.json({ data: [{ b64_json: image.toString('base64') }] });
  }
  return new Response('', { status: 404 });
};
