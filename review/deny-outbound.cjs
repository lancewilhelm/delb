// Test-process guard: permit loopback and Unix sockets, refuse outbound connections.
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
const isLoopback = (host) =>
  !host || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  let options = first;
  if (Array.isArray(first)) options = first[0];
  const host =
    typeof options === 'object' && options
      ? options.host
      : typeof args[1] === 'string'
        ? args[1]
        : undefined;
  if (!isLoopback(host))
    throw new Error('Review sandbox blocks outbound network connections');
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );
  if (!isLoopback(url.hostname))
    return Promise.reject(new Error('Review sandbox blocks outbound fetch'));
  return originalFetch(input, options);
};
