import assert from 'node:assert/strict';
import test from 'node:test';
import { readDownloadFilename } from './downloadFilename';

for (const [header, expected] of [
  ['attachment; filename="100% done.epub"', '100% done.epub'],
  ['attachment; filename="Literal%20title.epub"', 'Literal%20title.epub'],
  ['attachment; filename="Part; Two.epub"', 'Part; Two.epub'],
  ['attachment; filename=ordinary.epub', 'ordinary.epub'],
  ['attachment; filename="a\\"b.epub"', 'a"b.epub'],
  [
    "attachment; filename=legacy.epub; filename*=UTF-8''%E6%9C%AC.epub",
    '本.epub',
  ],
  [
    "attachment; filename*=UTF-8''%E6%9C%AC.epub; filename=legacy.epub",
    '本.epub',
  ],
  ["attachment; FILENAME*=utf-8'en'100%25%20done.epub", '100% done.epub'],
  [
    "attachment; filename*=UTF-8''broken%2; filename=fallback.epub",
    'fallback.epub',
  ],
  ["attachment; filename*=UTF-8''%FF; filename=fallback.epub", 'fallback.epub'],
  [
    "attachment; filename*=ISO-8859-1''%A3.epub; filename=fallback.epub",
    'fallback.epub',
  ],
  ["attachment; filename*=UTF-8''broken%2", null],
  ['attachment; xfilename=wrong.epub', null],
  ['attachment; filename=""', null],
  ['', null],
] as const) {
  test(`download filename: ${header || '(no header)'}`, () => {
    assert.equal(readDownloadFilename(header), expected);
  });
}
