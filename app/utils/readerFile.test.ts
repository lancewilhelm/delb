import assert from 'node:assert/strict';
import test from 'node:test';
import { pdfLocation, pdfPage, selectReaderFile } from './readerFile';

test('reader selection keeps EPUB preferred and supports PDF-only and explicit PDF', () => {
  const pdf = { id: 'pdf', format: ' PDF ' };
  const epub = { id: 'epub', format: 'EPUB' };
  const mobi = { id: 'mobi', format: 'mobi' };
  assert.equal(selectReaderFile([pdf, epub]), epub);
  assert.equal(selectReaderFile([pdf, mobi]), pdf);
  assert.equal(selectReaderFile([epub, pdf], 'pdf'), pdf);
  assert.equal(selectReaderFile([epub], 'pdf'), null);
  assert.equal(selectReaderFile([mobi]), null);
  assert.equal(selectReaderFile([]), null);
});

test('PDF positions restore only the same file, reject malformed input, and clamp stale pages', () => {
  const file = 'file:with/slashes';
  assert.equal(pdfPage(pdfLocation(file, 3), file, 10), 3);
  assert.equal(pdfPage(pdfLocation(file, 30), file, 10), 10);
  assert.equal(pdfPage(pdfLocation(file, 3), 'replacement', 10), 1);
  for (const location of [
    null,
    '',
    'epubcfi(/6/2)',
    'pdf:file:0',
    'pdf:file:-1',
    'pdf:file:1.5',
    'pdf:file:Infinity',
    'pdf:file:9007199254740992',
  ]) {
    assert.equal(pdfPage(location, 'file', 10), 1);
  }
});
