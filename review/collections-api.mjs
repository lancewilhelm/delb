import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { fetchAuth } from './fetch-auth.mjs';

const base = 'http://127.0.0.1:4317';
assert.equal(
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim(),
  'synthetic-delb-review',
);
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
async function request(route, user, method = 'GET', body) {
  const response = await fetchAuth(base + route, {
    method,
    headers: {
      Origin: base,
      ...(user ? { Cookie: user.cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, data: await response.json() };
}
async function signup(label) {
  const email = `collections-${label}-${randomBytes(5).toString('hex')}@example.invalid`;
  const password = randomBytes(20).toString('hex');
  const response = await fetchAuth(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: label, email, password }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return {
    id: (await response.json()).user.id,
    email,
    password,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
async function expect(route, user, method, body, status = 200) {
  const result = await request(route, user, method, body);
  assert.equal(
    result.status,
    status,
    `${method ?? 'GET'} ${route}: ${JSON.stringify(result.data)}`,
  );
  return result.data.data;
}
async function createCollection(user, name) {
  return (await expect('/api/collections', user, 'POST', { name })).collection
    .id;
}
async function createBook(user, title, collectionId) {
  return (
    await expect('/api/books', user, 'POST', {
      title,
      authors: ['Collection fixture author'],
      ...(collectionId ? { collectionIds: [collectionId] } : {}),
    })
  ).book.id;
}
let calibre;
try {
  const owner = await signup('owner');
  const editor = await signup('editor');
  const observer = await signup('observer');
  const initial = (await expect('/api/collections', owner)).collections;
  assert.equal(initial.length, 1);
  assert.equal(initial[0].name, 'Default');
  assert.equal(initial[0].isDefault, true);
  const originalDefault = initial[0].id;
  assert.equal(
    (await expect('/api/collections', editor)).collections[0].role,
    'editor',
  );
  assert.equal(
    (
      await db.execute(
        'SELECT count(*) AS n FROM collections WHERE is_personal=1',
      )
    ).rows[0].n,
    0,
  );
  await expect(`/api/collections/${originalDefault}`, editor, 'PUT', {
    name: 'Shared library',
  });
  const sharedBook = await createBook(owner, 'Shared permissions');
  await expect(`/api/books/${sharedBook}`, editor, 'PUT', {
    title: 'Edited by another member',
  });
  await expect(
    `/api/collections/${originalDefault}/leave`,
    observer,
    'POST',
    {},
  );
  assert.equal(
    (await expect('/api/collections', observer)).collections.length,
    0,
  );
  await expect(
    '/api/books',
    observer,
    'POST',
    { title: 'Cannot upload without membership', authors: ['Fixture'] },
    403,
  );
  await expect(`/api/books/${sharedBook}`, observer, 'GET', undefined, 404);
  const login = await fetchAuth(base + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: observer.email,
      password: observer.password,
    }),
  });
  assert.equal(login.status, 200);
  observer.cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.equal(
    (await expect('/api/collections', observer)).collections.length,
    0,
  );
  const zeroOwned = await createCollection(
    observer,
    'Created from zero memberships',
  );
  assert.equal(
    (await expect('/api/collections', observer)).collections[0].role,
    'owner',
  );
  await expect(
    `/api/collections/${zeroOwned}/leave`,
    observer,
    'POST',
    {},
    400,
  );
  await expect('/api/users/delete', owner, 'DELETE', { id: observer.id }, 409);
  await expect(`/api/collections/${zeroOwned}`, observer, 'DELETE', {
    confirmationName: 'Created from zero memberships',
    deleteBooks: true,
  });
  console.log(
    'PASS shared onboarding, rename, cross-creator editing, zero memberships and no sign-in re-enrollment',
  );

  const source = await createCollection(owner, 'Source private');
  const target = await createCollection(editor, 'Target private');
  await expect(`/api/collections/${source}/members`, owner, 'PUT', {
    email: editor.email,
    role: 'editor',
  });
  const movable = await createBook(editor, 'Independent copy fixture', source);
  await expect(`/api/collections/${source}/members`, owner, 'PUT', {
    email: editor.email,
    role: 'viewer',
  });
  await expect(
    `/api/books/${movable}`,
    editor,
    'PUT',
    { title: 'Creator cannot bypass viewer role' },
    403,
  );
  // Copy indicators are shared, independent, and guarded by collection roles.
  assert.equal(
    (await expect(`/api/books/${movable}`, editor)).book.hasPhysicalCopy,
    false,
  );
  const firstCopyUpdate = await expect(
    '/api/books/bulk/copies',
    editor,
    'POST',
    {
      bookIds: [sharedBook, movable],
      physical: true,
    },
  );
  assert.deepEqual(firstCopyUpdate, { updated: 1, skipped: 1 });
  assert.equal(
    (await expect(`/api/books/${sharedBook}`, owner)).book.hasPhysicalCopy,
    true,
  );
  assert.equal(
    (await expect(`/api/books/${movable}`, owner)).book.hasPhysicalCopy,
    false,
  );
  await expect('/api/books/bulk/copies', owner, 'POST', {
    bookIds: [movable],
    audiobook: true,
  });
  await expect('/api/books/bulk/copies', owner, 'POST', {
    bookIds: [movable],
    physical: true,
  });
  const bothCopies = (await expect(`/api/books/${movable}`, editor)).book;
  assert.equal(bothCopies.hasPhysicalCopy, true);
  assert.equal(bothCopies.hasAudiobookCopy, true);
  const bothFiltered = (
    await expect('/api/books?physical=marked&audiobook=marked', owner)
  ).books;
  assert.ok(bothFiltered.some((book) => book.id === movable));
  assert.ok(!bothFiltered.some((book) => book.id === sharedBook));
  const missingAudio = (
    await expect('/api/books?physical=marked&audiobook=unmarked', owner)
  ).books;
  assert.ok(missingAudio.some((book) => book.id === sharedBook));
  assert.ok(!missingAudio.some((book) => book.id === movable));
  await expect('/api/books/bulk/copies', owner, 'POST', {
    bookIds: [movable],
    physical: false,
  });
  assert.equal(
    (await expect(`/api/books/${movable}`, owner)).book.hasAudiobookCopy,
    true,
  );
  await expect(
    '/api/books/bulk/copies',
    owner,
    'POST',
    { bookIds: [movable], physical: 'yes' },
    400,
  );
  console.log(
    'PASS shared copy indicators, combined filters, independent changes and viewer skips',
  );
  await expect(`/api/books/${movable}`, editor, 'DELETE', undefined, 403);
  await expect(
    `/api/books/${movable}/collections`,
    editor,
    'PUT',
    { collectionId: target, sourceCollectionId: source, confirmed: true },
    403,
  );
  await expect(`/api/collections/${source}/members`, owner, 'PUT', {
    email: editor.email,
    role: 'editor',
  });
  await expect(`/api/books/${movable}/status`, editor, 'POST', {
    status: 'reading',
  });
  await expect(
    '/api/books/move',
    editor,
    'POST',
    {
      bookIds: [movable],
      targetCollectionId: target,
      expectedSources: [{ bookId: movable, collectionId: source }],
      confirmed: false,
    },
    400,
  );
  await expect('/api/books/move', editor, 'POST', {
    bookIds: [movable],
    targetCollectionId: target,
    expectedSources: [{ bookId: movable, collectionId: source }],
    confirmed: true,
  });
  await expect(`/api/books/${movable}`, owner, 'GET', undefined, 404);
  assert.equal(
    (await expect(`/api/books/${movable}`, editor)).book.userStatus,
    'reading',
  );
  await expect(`/api/collections/${target}/books/bulk`, editor, 'POST', {
    bookIds: [movable],
    targetCollectionId: source,
    confirmed: true,
  });
  assert.equal((await expect(`/api/books/${movable}`, owner)).book.id, movable);
  const metadata = {
    provider: 'googleBooks',
    item: {
      id: 'collection-fixture',
      volumeInfo: {
        title: 'Independent copy fixture',
        authors: ['Collection fixture author'],
      },
    },
    collectionIds: [target],
    existingBookId: movable,
  };
  await expect(
    '/api/books/metadata-import/create',
    editor,
    'POST',
    { ...metadata, duplicateAction: 'use_existing' },
    409,
  );
  const duplicate = (
    await expect('/api/books/metadata-import/create', editor, 'POST', {
      ...metadata,
      duplicateAction: 'add_new',
    })
  ).book.id;
  assert.notEqual(duplicate, movable);
  assert.equal(
    (await expect(`/api/books/${movable}`, editor)).book.collectionId,
    source,
  );
  assert.equal(
    (await expect(`/api/books/${duplicate}`, editor)).book.collectionId,
    target,
  );
  const health = await expect('/api/settings/admin/health', owner, 'POST', {
    mode: 'quick',
  });
  const duplicateCheck = health.results.find(
    (result) => result.id === 'duplicates.cross-collection-titles',
  );
  assert.equal(duplicateCheck.status, 'warn');
  assert.match(JSON.stringify(duplicateCheck.sample), /Source private/);
  assert.match(JSON.stringify(duplicateCheck.sample), /Target private/);
  console.log(
    'PASS exclusive atomic moves, source revocation, preserved history, viewer/creator denial and advisory duplicate review',
  );

  await expect(
    '/api/settings/admin/collections/default',
    editor,
    'PUT',
    { collectionId: target },
    403,
  );
  await expect('/api/settings/admin/collections/default', owner, 'PUT', {
    collectionId: target,
  });
  assert.equal(
    (await expect('/api/collections', owner)).collections.some(
      (collection) => collection.id === target,
    ),
    false,
  );
  assert.ok(
    (await expect('/api/settings/admin/collections', owner)).collections.some(
      (collection) => collection.id === target,
    ),
  );
  const newcomer = await signup('newcomer');
  assert.deepEqual(
    (await expect('/api/collections', newcomer)).collections.map(
      (collection) => [collection.id, collection.role],
    ),
    [[target, 'editor']],
  );
  const newBook = await createBook(newcomer, 'New default destination');
  assert.equal(
    (await expect(`/api/books/${newBook}`, newcomer)).book.collectionId,
    target,
  );
  await expect(
    '/api/books',
    owner,
    'POST',
    { title: 'Default does not grant access', authors: ['Fixture'] },
    403,
  );
  const targetName = (
    await expect('/api/settings/admin/collections', owner)
  ).collections.find((collection) => collection.id === target).name;
  const deletion = { confirmationName: targetName, deleteBooks: true };
  await expect(`/api/collections/${target}`, editor, 'DELETE', deletion, 409);
  await expect(`/api/collections/${target}/transfer-ownership`, owner, 'POST', {
    email: newcomer.email,
  });
  await expect(
    '/api/auth/admin/remove-user',
    owner,
    'POST',
    { userId: newcomer.id },
    400,
  );
  await expect('/api/settings/admin/collections/default', owner, 'PUT', {
    collectionId: originalDefault,
  });
  await expect(
    `/api/collections/${target}`,
    newcomer,
    'DELETE',
    undefined,
    400,
  );
  await expect(
    `/api/collections/${target}`,
    owner,
    'DELETE',
    { ...deletion, confirmationName: 'Wrong name' },
    409,
  );
  await expect(`/api/collections/${target}`, observer, 'DELETE', deletion, 403);
  await expect(`/api/collections/${target}`, newcomer, 'DELETE', deletion);
  await expect(`/api/books/${newBook}`, newcomer, 'GET', undefined, 404);
  await expect(`/api/books/${duplicate}`, newcomer, 'GET', undefined, 404);
  assert.equal(
    (
      await db.execute(
        'SELECT count(*) AS n FROM collections WHERE is_default=1',
      )
    ).rows[0].n,
    1,
  );
  console.log(
    'PASS administrative default changes, prospective enrollment, ownership recovery and confirmed populated deletion',
  );

  await mkdir('calibre/fixture', { recursive: true });
  await writeFile(
    'calibre/fixture/book.epub',
    await readFile('review/demo/ordinary.epub'),
  );
  calibre = createClient({ url: 'file:./calibre/metadata.db' });
  await calibre.execute(
    'CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT,path TEXT)',
  );
  await calibre.execute(
    "INSERT INTO books VALUES(1001,'Calibre canonical','fixture')",
  );
  await expect('/api/settings/admin/calibre', owner, 'POST', {
    action: 'import',
    collectionIds: [source],
    dryRun: true,
  });
  assert.equal(
    (
      await db.execute(
        'SELECT count(*) AS n FROM books WHERE calibre_book_id=1001',
      )
    ).rows[0].n,
    0,
  );
  await expect('/api/settings/admin/calibre', owner, 'POST', {
    action: 'import',
    collectionIds: [source],
  });
  const calibreId = (
    await db.execute('SELECT id FROM books WHERE calibre_book_id=1001')
  ).rows[0].id;
  assert.equal(
    (await expect(`/api/books/${calibreId}`, owner)).book.collectionId,
    source,
  );
  await expect(
    '/api/settings/admin/calibre',
    owner,
    'POST',
    { action: 'import', collectionIds: [source, originalDefault] },
    400,
  );
  console.log(
    'PASS Calibre dry run, single-target import and stored format file',
  );

  // Resume claims with their retained destination, even after configuration changes.
  const claimId = randomUUID();
  const deniedClaimId = randomUUID();
  const missingClaimId = randomUUID();
  const dropboxTarget = await createCollection(
    owner,
    'Dropbox retained collection',
  );
  await mkdir('dropbox', { recursive: true });
  await db.execute({
    sql: 'INSERT INTO system_state(key,value) VALUES(?,?),(?,?)',
    args: [
      `dropbox-claim:${claimId}`,
      JSON.stringify({ ownerUserId: owner.id, collectionIds: [dropboxTarget] }),
      `dropbox-claim:${deniedClaimId}`,
      JSON.stringify({
        ownerUserId: editor.id,
        collectionIds: [dropboxTarget],
      }),
    ],
  });
  await writeFile(
    `dropbox/Dropbox retained target.pdf.delb-processing-${claimId}`,
    'retained claim bytes',
  );
  await writeFile(
    `dropbox/Dropbox denied target.pdf.delb-processing-${deniedClaimId}`,
    'denied claim bytes',
  );
  await writeFile(
    `dropbox/Dropbox unknown target.pdf.delb-processing-${missingClaimId}`,
    'unrecorded claim bytes',
  );
  await expect('/api/settings/global', owner, 'PUT', {
    settings: {
      allowRegistration: true,
      dropbox: {
        enabled: true,
        pollIntervalMs: 100,
        stablePassesRequired: 1,
        targetCollectionId: originalDefault,
        targetUserId: owner.id,
      },
    },
  });
  let dropboxRows = [];
  let errors = [];
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    dropboxRows = (
      await db.execute(
        "SELECT id,collection_id FROM books WHERE title='Dropbox retained target'",
      )
    ).rows;
    try {
      errors = (await readdir('dropbox/failed')).filter((file) =>
        file.endsWith('.error.txt'),
      );
    } catch {
      errors = [];
    }
    if (dropboxRows.length === 1 && errors.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(dropboxRows.length, 1, 'watcher must resume the retained claim');
  assert.equal(
    dropboxRows[0].collection_id,
    dropboxTarget,
    'configured/default changes must not redirect a claim',
  );
  const dropboxFile = (
    await db.execute({
      sql: 'SELECT relative_path FROM book_files WHERE book_id=?',
      args: [dropboxRows[0].id],
    })
  ).rows[0].relative_path;
  assert.equal(await readFile(dropboxFile, 'utf8'), 'retained claim bytes');
  assert.equal(
    errors.length,
    2,
    'denied and unrecorded destinations must stop imports',
  );
  const reasons = await Promise.all(
    errors.map((file) => readFile(`dropbox/failed/${file}`, 'utf8')),
  );
  assert.ok(reasons.some((text) => text.includes('retained destination')));
  assert.ok(reasons.some((text) => text.includes('editor access')));
  assert.equal(
    (
      await db.execute(
        "SELECT count(*) AS n FROM books WHERE title IN ('Dropbox denied target','Dropbox unknown target')",
      )
    ).rows[0].n,
    0,
  );
  await expect('/api/settings/global', owner, 'PUT', {
    settings: { allowRegistration: true, dropbox: { enabled: false } },
  });
  console.log(
    'PASS Dropbox claim recovery retains destination, verifies bytes and stops revoked or unknown target imports',
  );

  // Stage the supported legacy relation in this disposable database, then drive the real admin migration API.
  const second = await createCollection(owner, 'Migration second collection');
  await db.execute(
    'INSERT INTO legacy_collection_books(collection_id,book_id,added_by_user_id,added_at) SELECT collection_id,id,added_by_user_id,added_at FROM books',
  );
  await db.execute({
    sql: 'INSERT INTO legacy_collection_books(collection_id,book_id,added_at) VALUES(?,?,0),(?,?,0)',
    args: [second, movable, second, calibreId],
  });
  await db.execute(
    "UPDATE system_state SET value='pending' WHERE key='collections-model'",
  );
  await expect('/api/books', owner, 'GET', undefined, 503);
  await expect(
    '/api/settings/admin/collections-migration',
    editor,
    'GET',
    undefined,
    403,
  );
  const preview = await expect(
    '/api/settings/admin/collections-migration',
    owner,
  );
  assert.equal(preview.splits.length, 2);
  const body = {
    fingerprint: preview.fingerprint,
    choices: [
      { bookId: movable, collectionId: source },
      { bookId: calibreId, collectionId: source },
    ],
    backupConfirmed: false,
  };
  await expect(
    '/api/settings/admin/collections-migration',
    owner,
    'POST',
    body,
    400,
  );
  await expect('/api/settings/admin/collections-migration', owner, 'POST', {
    ...body,
    backupConfirmed: true,
  });
  await expect('/api/books', owner);
  assert.equal(
    (await expect('/api/settings/admin/collections-migration', owner)).state,
    'exclusive',
  );
  assert.equal(
    (
      await db.execute({
        sql: 'SELECT count(*) AS n FROM books WHERE title=?',
        args: ['Independent copy fixture'],
      })
    ).rows[0].n,
    2,
  );
  console.log(
    'PASS production-server migration preview/apply authorization, backup gate, maintenance gate and independent splitting',
  );
  await calibre.execute(
    "UPDATE books SET title='Calibre rescanned' WHERE id=1001",
  );
  await expect('/api/settings/admin/calibre', owner, 'POST', {
    action: 'rescan',
    collectionIds: [source],
  });
  assert.equal(
    (await expect(`/api/books/${calibreId}`, owner)).book.title,
    'Calibre rescanned',
  );
  const independent = (
    await db.execute({
      sql: "SELECT id,title FROM books WHERE collection_id=? AND title='Calibre canonical'",
      args: [second],
    })
  ).rows;
  assert.equal(independent.length, 1);
  console.log(
    'PASS Calibre rescan updates its designated entry and preserves the independent migrated copy',
  );
  // A deterministic revocation after the first known entry proves each rescan rechecks the batch target.
  const importer = await signup('calibre-admin');
  await db.execute({
    sql: "UPDATE users SET role='admin' WHERE id=?",
    args: [importer.id],
  });
  const batchTarget = await createCollection(owner, 'Calibre batch target');
  for (const collectionId of [source, batchTarget])
    await expect(`/api/collections/${collectionId}/members`, owner, 'PUT', {
      email: importer.email,
      role: 'editor',
    });
  const nextCalibreId = await createBook(
    owner,
    'Unchanged after revoked batch target',
    source,
  );
  await db.execute({
    sql: 'UPDATE books SET calibre_book_id=1002 WHERE id=?',
    args: [nextCalibreId],
  });
  await calibre.execute(
    "INSERT INTO books VALUES(1002,'Must not rescan after revocation','fixture')",
  );
  const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
  await db.execute(
    `CREATE TRIGGER revoke_calibre_batch AFTER UPDATE OF title ON books WHEN NEW.id=${literal(calibreId)} BEGIN DELETE FROM collection_members WHERE collection_id=${literal(batchTarget)} AND user_id=${literal(importer.id)}; END`,
  );
  try {
    await expect(
      '/api/settings/admin/calibre',
      importer,
      'POST',
      { action: 'rescan', collectionIds: [batchTarget] },
      403,
    );
    assert.equal(
      (await expect(`/api/books/${nextCalibreId}`, owner)).book.title,
      'Unchanged after revoked batch target',
    );
  } finally {
    await db.execute('DROP TRIGGER revoke_calibre_batch');
  }
  console.log(
    'PASS Calibre rescans stop when the retained batch destination loses editor access',
  );
} finally {
  calibre?.close();
  db.close();
}
