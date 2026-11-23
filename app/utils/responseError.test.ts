import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFetchErrorMessage,
  readResponseError,
} from './responseError.ts';

test('extractFetchErrorMessage prefers server data.message over generic FetchError message', () => {
  const fetchErr = Object.assign(
    new Error('[GET] "/api/books/metadata/search": 429 Too Many Requests'),
    {
      statusMessage: 'Too Many Requests',
      data: {
        success: false,
        statusCode: 429,
        statusMessage: 'Google Books API quota exceeded.',
        message:
          'Google Books API quota exceeded. Configure a Google Books API key in Admin Settings → Metadata, or switch to Hardcover.',
      },
    },
  );

  assert.equal(
    extractFetchErrorMessage(fetchErr),
    'Google Books API quota exceeded. Configure a Google Books API key in Admin Settings → Metadata, or switch to Hardcover.',
  );
});

test('extractFetchErrorMessage falls back to data.statusMessage, statusMessage, then Error.message', () => {
  assert.equal(
    extractFetchErrorMessage({ data: { statusMessage: 'Quota exceeded' } }),
    'Quota exceeded',
  );
  assert.equal(
    extractFetchErrorMessage({ statusMessage: 'Too Many Requests' }),
    'Too Many Requests',
  );
  assert.equal(
    extractFetchErrorMessage(new Error('Network down')),
    'Network down',
  );
  assert.equal(extractFetchErrorMessage(null), null);
});

test('readResponseError reads JSON statusMessage or message and falls back cleanly', async () => {
  const res = new Response(
    JSON.stringify({ message: 'Google Books API quota exceeded.' }),
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  );
  assert.equal(
    await readResponseError(res, 'Fallback error'),
    'Google Books API quota exceeded.',
  );

  const empty = new Response('', { status: 500 });
  assert.equal(
    await readResponseError(empty, 'Fallback error'),
    'Fallback error',
  );
});
