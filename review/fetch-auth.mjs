import assert from 'node:assert/strict';

export async function fetchAuth(url, options) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429 || attempt === 2) return response;
    const seconds = Number(response.headers.get('X-Retry-After'));
    assert.ok(seconds > 0 && seconds <= 15, 'bounded auth rate-limit delay');
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 100));
  }
}
