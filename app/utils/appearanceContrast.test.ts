import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import themes from '../assets/json/themes.json';
import {
  appearanceContrastTarget,
  appearanceContrastVariables,
  normalizeAppearanceContrast,
} from './appearanceContrast';

test('contrast keeps T3 text and border curves continuous at the original theme', () => {
  const cases: [number, number, number, number][] = [
    [50, 50, 0, 0],
    [95, 95, 0, 0],
    [100, 100, 0, 0],
    [105, 100, 5, 1.25],
    [150, 100, 50, 12.5],
    [200, 100, 100, 25],
  ];
  for (const [value, base, boost, border] of cases) {
    assert.deepEqual(appearanceContrastVariables(value), {
      '--appearance-contrast-base': `${base}%`,
      '--appearance-contrast-boost': `${boost}%`,
      '--appearance-contrast-border-boost': `${border}%`,
    });
  }
});

test('contrast target follows the palette background rather than the OS mode', () => {
  for (const background of ['#ffffff', '#ddd', '#ffeecc', '#cccccc'])
    assert.equal(appearanceContrastTarget(background), 'black');
  for (const background of ['#000000', '#1b1b1b', '#003344', '#252525'])
    assert.equal(appearanceContrastTarget(background), 'white');
});

test('inverse error text uses each preset’s authored error background', () => {
  for (const theme of themes) {
    const css = readFileSync(
      new URL(`../../public/css/themes/${theme.name}.css`, import.meta.url),
      'utf8',
    );
    const authored = /--error-color:\s*([^;]+);/.exec(css)?.[1]?.trim();
    assert.equal(theme.errorColor, authored, theme.name);
  }
});

test('saved contrast values are finite integers inside the supported range', () => {
  for (const invalid of [undefined, null, '150', NaN, Infinity, {}])
    assert.equal(normalizeAppearanceContrast(invalid), 100);
  assert.equal(normalizeAppearanceContrast(0), 50);
  assert.equal(normalizeAppearanceContrast(300), 200);
  assert.equal(normalizeAppearanceContrast(125.4), 125);
});
