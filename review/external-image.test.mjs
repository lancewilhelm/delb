import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import sharp from 'sharp';
import { fetchExternalImageBuffer } from '../server/utils/books/external-image';

globalThis.createError = (options) =>
  Object.assign(new Error(options.statusMessage), options);

test('external image transport pins validated DNS, bounds responses and accepts only decoded raster images', async () => {
  const originalLookup = dns.lookup;
  const originalGet = http.get;
  const png = await sharp({
    create: { width: 1, height: 1, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  let addresses = [{ address: '93.184.216.34', family: 4 }];
  let resolved = 0;
  let requests = 0;
  let destroyed = false;
  let responseFactory = () => ({ status: 200, headers: {}, body: png });
  dns.lookup = async () => {
    resolved++;
    return addresses;
  };
  http.get = (url, options, callback) => {
    requests++;
    assert.equal(url.hostname, 'covers.example');
    options.lookup('covers.example', {}, (error, address, family) => {
      assert.ifError(error);
      assert.equal(address, '93.184.216.34');
      assert.equal(family, 4);
    });
    const request = new EventEmitter();
    const data = responseFactory();
    const response = new PassThrough();
    response.statusCode = data.status;
    response.headers = data.headers;
    const destroy = response.destroy.bind(response);
    response.destroy = (...args) => {
      destroyed = true;
      return destroy(...args);
    };
    queueMicrotask(() => {
      callback(response);
      if (data.body) response.end(data.body);
    });
    options.signal.addEventListener('abort', () => {
      response.destroy();
      request.emit('error', new Error('aborted'));
    });
    return request;
  };
  try {
    const result = await fetchExternalImageBuffer(
      'http://covers.example/cover',
    );
    assert.equal(result.contentType, 'image/png');
    assert.equal((await sharp(result.bytes).metadata()).format, 'png');
    assert.equal(
      resolved,
      1,
      'connection must not resolve the hostname a second time',
    );
    assert.equal(requests, 1);
    for (const format of ['jpeg', 'webp']) {
      const body = await sharp(png).toFormat(format).toBuffer();
      responseFactory = () => ({ status: 200, headers: {}, body });
      assert.equal(
        (await fetchExternalImageBuffer('http://covers.example/cover'))
          .contentType,
        'image/png',
      );
    }

    let redirected = false;
    responseFactory = () => {
      if (!redirected) {
        redirected = true;
        return { status: 302, headers: { location: '/next' }, body: null };
      }
      return { status: 200, headers: {}, body: png };
    };
    const beforeRedirect = resolved;
    assert.equal(
      (await fetchExternalImageBuffer('http://covers.example/cover'))
        .contentType,
      'image/png',
    );
    assert.equal(
      resolved,
      beforeRedirect + 2,
      'each redirect must be resolved and validated',
    );
    responseFactory = () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    });
    await assert.rejects(
      fetchExternalImageBuffer('http://covers.example/cover'),
    );
    responseFactory = () => ({
      status: 200,
      headers: {},
      body: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await assert.rejects(
      fetchExternalImageBuffer('http://covers.example/cover'),
      (error) => error.statusCode === 413,
    );
    responseFactory = () => ({
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
      body: null,
    });
    destroyed = false;
    const before = requests;
    await assert.rejects(
      fetchExternalImageBuffer('http://covers.example/cover'),
      (error) => error.statusCode === 400,
    );
    assert.equal(requests, before + 1);
    assert.equal(destroyed, true);
    responseFactory = () => ({ status: 200, headers: {}, body: null });
    destroyed = false;
    await assert.rejects(
      fetchExternalImageBuffer('http://covers.example/cover'),
      /timed out/,
    );
    assert.equal(destroyed, true, 'timed out bodies must be destroyed');
    for (const address of [
      '127.0.0.1',
      '100.64.0.1',
      '192.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
    ]) {
      addresses = [{ address, family: address.includes(':') ? 6 : 4 }];
      await assert.rejects(
        fetchExternalImageBuffer('http://covers.example/cover'),
        (error) => error.statusCode === 400,
        address,
      );
    }
  } finally {
    dns.lookup = originalLookup;
    http.get = originalGet;
  }
});

test('actual HTTP socket receives the validated address', async () => {
  const png = await sharp({
    create: { width: 1, height: 1, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  const server = http.createServer((_request, response) => response.end(png));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const originalLookup = dns.lookup;
  const originalConnect = net.Socket.prototype.connect;
  let attemptedAddress;
  let dnsCalls = 0;
  dns.lookup = async () => {
    dnsCalls++;
    return [
      { address: dnsCalls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 },
    ];
  };
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (
      options &&
      typeof options === 'object' &&
      options.host === 'covers.example'
    ) {
      const lookup = options.lookup;
      options.lookup = (hostname, lookupOptions, callback) =>
        lookup(hostname, lookupOptions, (error, address, family) => {
          attemptedAddress = address;
          callback(error, '127.0.0.1', family);
        });
    }
    return originalConnect.apply(this, args);
  };
  try {
    const result = await fetchExternalImageBuffer(
      `http://covers.example:${server.address().port}/cover`,
    );
    assert.equal(result.contentType, 'image/png');
    assert.equal(attemptedAddress, '93.184.216.34');
    assert.equal(dnsCalls, 1);
  } finally {
    dns.lookup = originalLookup;
    net.Socket.prototype.connect = originalConnect;
    await new Promise((resolve) => server.close(resolve));
  }
});
