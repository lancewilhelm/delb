import dns from 'node:dns/promises';
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

function isIPv4Private(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)
  ) {
    return false;
  }

  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isIPv6Blocked(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true; // loopback
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
  if (normalized.startsWith('fe80')) return true; // link local
  if (normalized.startsWith('ff')) return true; // multicast
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  return false;
}

async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname;

  if (isBlockedHost(host)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid image URL host' });
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4 && isIPv4Private(host)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid image URL host' });
  }
  if (ipVersion === 6 && isIPv6Blocked(host)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid image URL host' });
  }

  if (ipVersion === 0) {
    const lookups = await dns.lookup(host, { all: true, verbatim: true });

    if (!lookups.length) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid image URL host' });
    }

    for (const entry of lookups) {
      const ip = entry.address;
      if (!ip) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid image URL host' });
      }

      const v = net.isIP(ip);
      if (v === 4 && isIPv4Private(ip)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid image URL host' });
      }
      if (v === 6 && isIPv6Blocked(ip)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid image URL host' });
      }
    }
  }
}

function parseLocation(current: URL, location: string): URL {
  try {
    return new URL(location, current);
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch external image' });
  }
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      throw createError({
        statusCode: 413,
        statusMessage: 'External image is too large',
      });
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

export async function fetchExternalImageBuffer(inputUrl: string): Promise<{
  bytes: Buffer;
  contentType: string;
}> {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid url' });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw createError({ statusCode: 400, statusMessage: 'Invalid url protocol' });
  }

  const maxRedirects = DEFAULT_MAX_REDIRECTS;
  const maxBytes = DEFAULT_MAX_BYTES;
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicHost(current);

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          Accept: 'image/*,*/*;q=0.8',
          'User-Agent': 'delb/external-image-fetcher',
        },
      });
    } catch {
      throw createError({ statusCode: 502, statusMessage: 'Failed to fetch external image' });
    } finally {
      clearTimeout(timeout);
    }

    const redirectStatus = [301, 302, 303, 307, 308];
    if (redirectStatus.includes(resp.status)) {
      if (i === maxRedirects) {
        throw createError({ statusCode: 502, statusMessage: 'Failed to fetch external image' });
      }

      const location = resp.headers.get('location');
      if (!location) {
        throw createError({ statusCode: 502, statusMessage: 'Failed to fetch external image' });
      }

      current = parseLocation(current, location);
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw createError({ statusCode: 400, statusMessage: 'Invalid url protocol' });
      }
      continue;
    }

    if (!resp.ok) {
      throw createError({ statusCode: 502, statusMessage: 'Failed to fetch external image' });
    }

    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw createError({ statusCode: 502, statusMessage: 'Failed to fetch external image' });
    }

    const contentLength = Number(resp.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw createError({ statusCode: 413, statusMessage: 'External image is too large' });
    }

    const bytes = await readBodyWithLimit(resp.body, maxBytes);
    return { bytes, contentType };
  }

  throw createError({ statusCode: 502, statusMessage: 'Failed to fetch external image' });
}
