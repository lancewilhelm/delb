import assert from 'node:assert/strict';
import sharp from './test-image.mjs';
import { createClient } from './sqlite-client.mjs';
import {
  account,
  expectStatus,
  json,
  request,
  setRole,
  setTagRules,
  tagBook,
} from './library-fixtures.mjs';

const owner = await account('shelf-owner');
const reader = await account('shelf-reader');
const editor = await account('shelf-editor');
await setRole(owner, editor, 'editor');
const path = '/api/library/bookshelf';
const db = createClient({ url: 'file:./review/demo/synthetic.db' });
const placedBooks = (snapshot) =>
  snapshot.arrangement.bookcases.flatMap((bookcase) =>
    bookcase.shelves.flatMap((shelf) =>
      shelf.items.flatMap((item) => item.books),
    ),
  );
const read = async (actor) => json(await request(actor, path));
const save = (actor, { revision, token, arrangement }) =>
  request(actor, path, 'PUT', { revision, token, arrangement });

try {
  const bookId = 'shelf-visible';
  await db.execute({
    sql: 'INSERT INTO books(id,title,sort_title,pages,created_at,updated_at) VALUES (?,?,?,?,1,1)',
    args: [bookId, 'Shelf test book', 'Shelf test book', 250],
  });
  const precomputed = await db.execute({
    sql: 'SELECT source_pages FROM book_shelf_dimensions WHERE book_id=?',
    args: [bookId],
  });
  assert.equal(precomputed.rows[0].source_pages, 250);
  await db.execute({
    sql: 'UPDATE books SET pages=? WHERE id=?',
    args: [900, bookId],
  });
  const hiddenBook = (
    await json(
      await request(owner, '/api/books', 'POST', {
        title: 'Hidden shelf book',
        authors: ['Shelf fixture author'],
      }),
    )
  ).data.book.id;
  const hiddenTag = await tagBook(owner, hiddenBook, 'Hidden on library shelf');
  const snapshot = await read(owner);
  assert.equal(snapshot.canEdit, true);
  assert.equal(snapshot.books.length, 2);
  const visibleBook = placedBooks(snapshot).find((book) => book.id === bookId);
  assert.equal(visibleBook.width, 55);
  assert.equal(visibleBook.sourcePages, 900);
  assert.equal((await read(reader)).canEdit, false);
  await expectStatus(await save(reader, snapshot), 403);

  const beforeSave = await db.execute(
    "SELECT revision FROM bookshelf_layouts WHERE scope_kind='library' AND scope_id='main'",
  );
  assert.equal(
    beforeSave.rows.length,
    0,
    'Opening a shelf does not save an arrangement',
  );
  await expectStatus(await save(owner, snapshot));
  await expectStatus(await save(owner, snapshot), 409);
  const saved = await read(reader);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.arrangement, snapshot.arrangement);

  const editable = await read(editor);
  assert.equal(editable.canEdit, true);
  const simultaneous = await Promise.all([
    save(owner, editable),
    save(editor, editable),
  ]);
  assert.deepEqual(
    simultaneous.map((response) => response.status).sort(),
    [200, 409],
  );

  await setTagRules(owner, editor, { blockTagIds: [hiddenTag.id] });
  const restricted = await read(editor);
  assert.equal(restricted.canEdit, false);
  assert.deepEqual(
    restricted.books.map((book) => book.id),
    [bookId],
  );
  assert.deepEqual(
    placedBooks(restricted).map((book) => book.id),
    [bookId],
  );
  await expectStatus(await save(editor, restricted), 403);
  const matches = await json(
    await request(editor, '/api/books?idsOnly=1&limit=20000'),
  );
  assert.deepEqual(matches.data.books, [{ id: bookId }]);

  const beforeDelete = await read(owner);
  await expectStatus(
    await request(owner, `/api/books/${hiddenBook}`, 'DELETE'),
  );
  await expectStatus(await save(owner, beforeDelete), 409);
  const afterDelete = await read(owner);
  assert.deepEqual(
    placedBooks(afterDelete).map((book) => book.id),
    [bookId],
  );
  const forged = structuredClone(afterDelete);
  placedBooks(forged)[0].id = hiddenBook;
  await expectStatus(await save(owner, forged), 409);

  const picture = new FormData();
  const bytes = await sharp({
    create: { width: 40, height: 20, channels: 3, background: '#225588' },
  })
    .png()
    .toBuffer();
  picture.append('file', new Blob([bytes], { type: 'image/png' }), 'shelf.png');
  const picturesPath = '/api/bookshelf-pictures/library/main';
  const asset = await json(await request(owner, picturesPath, 'POST', picture));
  assert.ok(asset.id);
  await expectStatus(await request(reader, picturesPath, 'POST', picture), 403);
  await expectStatus(await request(editor, picturesPath, 'POST', picture), 403);
  await expectStatus(
    await request(
      owner,
      '/api/bookshelf-pictures/library/unknown',
      'POST',
      picture,
    ),
    404,
  );
  console.log(
    'PASS library bookshelf permissions, visibility, revisions, spine dimensions, and library picture scope',
  );
} finally {
  db.close();
}
