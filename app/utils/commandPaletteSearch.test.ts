import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { searchPaletteOptions } from './commandPaletteSearch';

const options = [
  {
    label: 'book grid',
    options: [{ label: 'reading status' }, { label: 'authors' }],
  },
  { label: 'cover style', options: [{ label: 'reading status badges' }] },
  { label: 'contrast' },
];

test('the initial menu stays compact and searches find nested settings', () => {
  assert.deepEqual(
    searchPaletteOptions(options, '').map((r) => r.option.label),
    ['book grid', 'cover style', 'contrast'],
  );
  const results = searchPaletteOptions(options, 'reading status');
  assert.deepEqual(
    results.map((r) => [r.option.label, r.path]),
    [
      ['reading status', 'book grid'],
      ['reading status badges', 'cover style'],
    ],
  );
});

test('search can use the group name and returns the original actionable option', () => {
  const result = searchPaletteOptions(options, 'grid authors')[0];
  assert.equal(result?.option, options[0]?.options?.[1]);
  assert.equal(result?.path, 'book grid');
  assert.deepEqual(searchPaletteOptions(options, 'no such setting'), []);
});
