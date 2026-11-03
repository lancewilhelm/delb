import assert from 'node:assert/strict';
import { validateHeaderValue } from 'node:http';
import test from 'node:test';
import { bookDownloadDisposition } from './download-disposition';
import { readDownloadFilename } from '../../../app/utils/downloadFilename';

for (const [title, expected] of [
  ['Ordinary Book', 'Ordinary Book'],
  ['日本語の本 📚', '日本語の本 📚'],
  ['Café — Ελληνικά', 'Café — Ελληνικά'],
  ['100% done; %2F stays literal', '100% done; %2F stays literal'],
  ["A reader's (new) book!", "A reader's (new) book!"],
  ['  Unsafe/\\:*?"<>|\r\nTitle\u0000\u007f ', 'Unsafe_ Title__'],
  ['\ud800broken', '�broken'],
  [' ', 'book'],
]) {
  test(`download header preserves a safe filename for ${JSON.stringify(title)}`, () => {
    for (const format of ['epub', 'pdf', 'mobi', 'azw3']) {
      const header = bookDownloadDisposition(title, format);
      assert.doesNotThrow(() =>
        validateHeaderValue('Content-Disposition', header),
      );
      assert.match(header, /^[\x20-\x7e]+$/);
      assert.equal(readDownloadFilename(header), `${expected}.${format}`);
      const fallback = /filename="([^"]+)"/.exec(header)?.[1];
      assert.ok(fallback?.endsWith(`.${format}`));
      assert.ok(!fallback.includes('%'));
    }
  });
}
