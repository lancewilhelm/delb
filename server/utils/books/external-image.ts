import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_PIXELS = 40_000_000;

function failure(
  statusCode = 502,
  statusMessage = 'Failed to fetch external image',
) {
  return createError({ statusCode, statusMessage });
}

function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const ip = ipaddr.parse(address);
  if (ip.range() !== 'unicast') return false;
  if (ip.kind() === 'ipv4') {
    const ipv4 = ipaddr.IPv4.parse(address);
    return (
      !ipv4.match(ipaddr.IPv4.parse('192.0.0.0'), 24) &&
      !ipv4.match(ipaddr.IPv4.parse('192.88.99.0'), 24)
    );
  }
  const ipv6 = ipaddr.IPv6.parse(address);
  return (
    ipv6.match(ipaddr.IPv6.parse('2000::'), 3) &&
    !ipv6.match(ipaddr.IPv6.parse('2001::'), 23) &&
    !ipv6.match(ipaddr.IPv6.parse('2002::'), 16)
  );
}

function parseUrl(input: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw failure(400, 'Invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw failure(400, 'Invalid url protocol');
  }
  if (url.username || url.password)
    throw failure(400, 'Invalid image URL host');
  return url;
}

async function resolvePublicAddress(
  url: URL,
): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw failure(400, 'Invalid image URL host');
  }
  const family = net.isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw failure(400, 'Invalid image URL host');
  }
  const selected = addresses[0]!;
  if (selected.family !== 4 && selected.family !== 6)
    throw failure(400, 'Invalid image URL host');
  return { address: selected.address, family: selected.family };
}

async function requestImage(
  url: URL,
  address: { address: string; family: 4 | 6 },
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        signal,
        agent: false,
        family: address.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
        headers: {
          Accept: 'image/jpeg,image/png,image/webp',
          'User-Agent': 'delb/external-image-fetcher',
        },
      },
      resolve,
    );
    request.on('error', reject);
  });
}

async function fetchImage(
  inputUrl: string,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string }> {
  let current = parseUrl(inputUrl);
  for (let i = 0; i <= DEFAULT_MAX_REDIRECTS; i++) {
    const address = await resolvePublicAddress(current);
    signal.throwIfAborted();
    const response = await requestImage(current, address, signal);
    try {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (i === DEFAULT_MAX_REDIRECTS || !response.headers.location)
          throw failure();
        current = parseUrl(response.headers.location, current);
        continue;
      }
      if (status < 200 || status >= 300) throw failure();
      const length = Number(response.headers['content-length'] || 0);
      if (Number.isFinite(length) && length > DEFAULT_MAX_BYTES)
        throw failure(413, 'External image is too large');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > DEFAULT_MAX_BYTES)
          throw failure(413, 'External image is too large');
        chunks.push(bytes);
      }
      const input = Buffer.concat(chunks);
      const image = sharp(input, {
        limitInputPixels: MAX_PIXELS,
        failOn: 'warning',
      });
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? ''))
        throw failure();
      const bytes = await image.timeout({ seconds: 10 }).png().toBuffer();
      if (bytes.length > DEFAULT_MAX_BYTES)
        throw failure(413, 'External image is too large');
      return { bytes, contentType: 'image/png' };
    } finally {
      response.destroy();
    }
  }
  throw failure();
}

export async function fetchExternalImageBuffer(
  inputUrl: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(failure(502, 'External image request timed out'));
    }, DEFAULT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      fetchImage(inputUrl, controller.signal),
      deadline,
    ]);
  } catch (error) {
    if (controller.signal.aborted)
      throw failure(502, 'External image request timed out');
    if (error && typeof error === 'object' && 'statusCode' in error)
      throw error;
    throw failure();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
