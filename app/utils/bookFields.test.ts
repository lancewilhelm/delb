import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultBookFields,
  normalizeBookFields,
  bookFieldParts,
} from './bookFields';

test('saved field order and cover-only choices survive normalization', () => {
  const fields = normalizeBookFields([
    { id: 'tags', visible: true },
    { id: 'title', visible: false },
    { id: 'tags', visible: false },
    { id: 'invalid', visible: true },
  ]);
  assert.deepEqual(fields.slice(0, 2), [
    { id: 'tags', visible: true },
    { id: 'title', visible: false },
  ]);
  assert.equal(new Set(fields.map((f) => f.id)).size, fields.length);
  assert.ok(normalizeBookFields([]).every((f) => !f.visible));
  assert.deepEqual(
    defaultBookFields()
      .filter((f) => f.visible)
      .map((f) => f.id),
    ['title', 'authors', 'series'],
  );
});

test('legacy grid selections are retained when adding field preferences', () => {
  const fields = normalizeBookFields(undefined, {
    showTitle: false,
    showAuthors: true,
    showSeries: false,
  });
  assert.deepEqual(
    fields.filter((f) => f.visible).map((f) => f.id),
    ['authors'],
  );
});

test('field values retain links, zero values and personal metadata', () => {
  const book = {
    id: 'b',
    title: 'Book',
    tags: [{ id: 't', name: 'Long tag' }],
    series: { id: 's', name: 'Series' },
    seriesIndex: 0,
    pages: 0,
    rating: 7,
    status: 'to_be_read',
    formats: ['epub', 'pdf'],
    identifiers: [{ type: 'isbn', value: '123' }],
  };
  assert.deepEqual(bookFieldParts(book, 'tags'), [
    { text: 'Long tag', to: '/tags/t' },
  ]);
  assert.match(
    bookFieldParts(book, 'series')
      .map((p) => p.text)
      .join(''),
    /#0/,
  );
  assert.equal(bookFieldParts(book, 'pages')[0]?.text, '0');
  assert.equal(bookFieldParts(book, 'rating')[0]?.text, '3.5 / 5');
  assert.equal(bookFieldParts(book, 'status')[0]?.text, 'To be read');
  assert.equal(bookFieldParts(book, 'formats')[0]?.text, 'EPUB, PDF');
  assert.deepEqual(bookFieldParts(book, 'publisher'), []);
});
