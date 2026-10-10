import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  customThemeCss,
  defaultCustomTheme,
  hexToHsv,
  hsvToHex,
  normalizeCustomTheme,
  normalizeHex,
} from './customTheme';
import { loadTheme } from './theme';

test('palette normalization accepts opaque hex and repairs missing or unsafe colors', () => {
  assert.equal(normalizeHex('#AbC'), '#aabbcc');
  assert.equal(normalizeHex('#ABCDEF'), '#abcdef');
  for (const value of [
    '#abcd',
    '#11223344',
    'red',
    '};body{display:none}',
    null,
  ])
    assert.equal(normalizeHex(value), undefined);
  assert.deepEqual(
    normalizeCustomTheme({ bgColor: '#123', errorColor: 'invalid' }),
    { ...defaultCustomTheme, bgColor: '#112233' },
  );
  assert.deepEqual(normalizeCustomTheme(null), defaultCustomTheme);
});

test('CSS includes six roles and derived legacy colors using validated values', () => {
  const css = customThemeCss({
    ...defaultCustomTheme,
    mainColor: '#123456',
    errorColor: '#abcdef',
    bgColor: '</style>',
  });
  assert.ok(css.includes('--bg-color:#dddddd;'));
  assert.ok(css.includes('--caret-color:#123456;'));
  assert.ok(css.includes('--colorful-error-extra-color:#abcdef;'));
  assert.equal((css.match(/--[a-z-]+:/g) ?? []).length, 10);
  assert.ok(!css.includes('</style>'));
});

test('HSV conversion preserves primary, neutral, and arbitrary colors', () => {
  for (const color of [
    '#000000',
    '#ffffff',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#ab8756',
  ]) {
    const { h, s, v } = hexToHsv(color);
    assert.equal(hsvToHex(h, s, v), color);
  }
});

test('theme switching cancels stale loads and cleans up custom styles', async () => {
  class Element {
    id = '';
    tagName: string;
    textContent = '';
    href = '';
    rel = '';
    onload: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    constructor(tag: string) {
      this.tagName = tag.toUpperCase();
    }
    remove() {
      elements.delete(this);
    }
    getAttribute(name: string) {
      return name === 'href' ? this.href : null;
    }
  }
  const elements = new Set<Element>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: (selector: string) =>
        [...elements].find((e) => '#' + e.id === selector) ?? null,
      createElement: (tag: string) => new Element(tag),
      head: { appendChild: (element: Element) => elements.add(element) },
    },
  });
  try {
    await loadTheme('custom', defaultCustomTheme);
    assert.equal([...elements][0]?.tagName, 'STYLE');
    const pending = loadTheme('serika_dark');
    const link = [...elements].find((e) => e.id === 'nextTheme')!;
    const staleOnload = link.onload!;
    await loadTheme('custom', { ...defaultCustomTheme, bgColor: '#112233' });
    await pending;
    staleOnload();
    assert.equal(elements.size, 1);
    assert.ok([...elements][0]?.textContent.includes('#112233'));
    const preset = loadTheme('guage');
    [...elements].find((e) => e.id === 'nextTheme')!.onload!();
    await preset;
    assert.equal(elements.size, 1);
    assert.equal([...elements][0]?.tagName, 'LINK');
    const another = loadTheme('paper');
    await loadTheme('guage');
    await another;
    assert.equal(elements.size, 1);
    await loadTheme();
    assert.equal(elements.size, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
