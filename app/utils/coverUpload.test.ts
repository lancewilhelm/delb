import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { readResponseError } from './responseError.ts';

async function loadEditor(response: () => Response, reset = false) {
  const raw = await readFile('app/components/Books/BookEditor.vue', 'utf8');
  const source = raw.slice(raw.indexOf('>') + 1, raw.indexOf('</script>'));
  const ast = ts.createSourceFile(
    'editor.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const wanted = ['uploadPendingCoverIfAny', 'updateBook'];
  const funcs = ast.statements
    .filter(
      (s) => ts.isFunctionDeclaration(s) && wanted.includes(s.name?.text ?? ''),
    )
    .map((s) => s.getText(ast))
    .join('\n');
  assert.ok(funcs.includes('async function updateBook'));
  const seen: string[] = [];
  const requests: string[] = [];
  let cleared = false;
  let navigated = false;
  let reloaded = false;
  const values = {
    readResponseError,
    book: { value: { id: 'synthetic' } },
    coverUploading: { value: false },
    coverResetPending: { value: reset },
    selectedCoverFile: {
      value: new File(['image'], 'cover.png') as File | null,
    },
    saving: { value: false },
    errorMessage: { value: null },
    successMessage: { value: null },
    setError: (s: string) => seen.push(s),
    setSuccess: () => {},
    commitPendingChips: () => {},
    buildPayload: () => ({}),
    validateRequiredFields: () => true,
    fetch: async (url: string, opts: { method: string }) => {
      requests.push(`${opts.method} ${url}`);
      return requests.length === 1
        ? new Response('{}', { status: 200 })
        : response();
    },
    clearSelectedCover: () => {
      cleared = true;
      values.selectedCoverFile.value = null;
    },
    loadBook: async () => {
      reloaded = true;
    },
    backToBook: () => {
      navigated = true;
    },
  };
  const js = ts.transpileModule(funcs, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await new Function(...Object.keys(values), `${js};return updateBook;`)(
    ...Object.values(values),
  )();
  return { seen, requests, values, cleared, navigated, reloaded };
}

for (const [status, message] of [
  [
    422,
    'EPUB cover update failed: Signed EPUBs cannot be modified without invalidating their signatures',
  ],
  [
    422,
    'EPUB cover update failed: The existing cover resource is encrypted: old.png',
  ],
  [
    422,
    'EPUB cover update failed: Invalid percent-encoding in EPUB href: 100%.css',
  ],
  [422, 'EPUB cover update failed: EPUB mimetype is missing or invalid'],
  [
    409,
    'An associated EPUB file is missing. Restore the file or correct its library entry, then retry the cover upload.',
  ],
  [413, 'Cover image exceeds the 25 MiB upload limit'],
  [415, 'Unsupported or invalid cover image'],
  [507, 'Library storage could not safely replace an existing cover file'],
] as const) {
  test(`editor preserves ${status} detail: ${message}`, async () => {
    const state = await loadEditor(
      () =>
        new Response(
          JSON.stringify({ statusCode: status, statusMessage: message }),
          { status },
        ),
    );
    assert.deepEqual(state.seen, [message]);
    assert.equal(state.cleared, false);
    assert.equal(state.navigated, false);
    assert.equal(state.reloaded, false);
    assert.ok(state.values.selectedCoverFile.value);
    assert.equal(state.values.saving.value, false);
    assert.equal(state.values.coverUploading.value, false);
  });
}

test('cover reset failure retains its detailed message and pending edits', async () => {
  const state = await loadEditor(
    () =>
      new Response(
        JSON.stringify({ statusMessage: 'You cannot edit this book.' }),
        { status: 403 },
      ),
    true,
  );
  assert.deepEqual(state.seen, ['You cannot edit this book.']);
  assert.equal(state.values.coverResetPending.value, true);
  assert.equal(state.navigated, false);
  assert.equal(state.requests[1], 'PUT /api/books/synthetic');
});

test('successful upload clears selection, reloads, and returns to book', async () => {
  const state = await loadEditor(
    () =>
      new Response(
        JSON.stringify({ data: { embeddedEpubs: 1, totalEpubs: 1 } }),
        { status: 200 },
      ),
  );
  assert.deepEqual(state.seen, []);
  assert.equal(state.cleared, true);
  assert.equal(state.reloaded, true);
  assert.equal(state.navigated, true);
  assert.equal(state.requests[1], 'POST /api/books/synthetic/cover');
});

test('API error parsing supports message, plain text and empty or unreadable bodies', async () => {
  assert.equal(
    await readResponseError(
      new Response('{"message":"Specific error"}'),
      'fallback',
    ),
    'Specific error',
  );
  assert.equal(
    await readResponseError(new Response('Plain error'), 'fallback'),
    'Plain error',
  );
  assert.equal(
    await readResponseError(new Response(''), 'fallback'),
    'fallback',
  );
  assert.equal(
    await readResponseError(new Response('{"statusCode":500}'), 'fallback'),
    'fallback',
  );
  const consumed = new Response('Already read');
  await consumed.text();
  assert.equal(await readResponseError(consumed, 'fallback'), 'fallback');
});
