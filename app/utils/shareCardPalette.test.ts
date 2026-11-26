import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCardPalette,
  contrastRatio,
  extractSwatches,
  hexToRgb,
  oklabToOklch,
  oklchToHex,
  paletteFromHex,
  paletteFromPixels,
  rgbToOklab,
} from './shareCardPalette.ts';

function pixels(colors: [number, number, number, number][], repeat = 1) {
  const out: number[] = [];
  for (const c of colors) for (let i = 0; i < repeat; i++) out.push(...c);
  return Uint8ClampedArray.from(out);
}

test('OKLab round-trips sRGB colors', () => {
  for (const hex of ['#000000', '#ffffff', '#2b5d60', '#d9775a', '#cbe67a']) {
    const rgb = hexToRgb(hex)!;
    const lch = oklabToOklch(rgbToOklab(rgb));
    assert.equal(oklchToHex(lch), hex);
  }
  const white = rgbToOklab({ r: 255, g: 255, b: 255 });
  assert.ok(Math.abs(white.L - 1) < 1e-4);
  assert.ok(Math.abs(white.a) < 1e-4 && Math.abs(white.b) < 1e-4);
});

test('out-of-gamut colors lose chroma but keep a valid hex', () => {
  const hex = oklchToHex({ L: 0.7, C: 0.5, h: 145 });
  assert.match(hex, /^#[0-9a-f]{6}$/);
  const back = oklabToOklch(rgbToOklab(hexToRgb(hex)!));
  assert.ok(Math.abs(back.L - 0.7) < 0.02, `lightness kept: ${back.L}`);
});

test('swatches skip transparent pixels and sort by weight', () => {
  const data = pixels(
    [
      [200, 40, 40, 255],
      [20, 60, 120, 255],
      [255, 255, 255, 0],
    ],
    1,
  );
  const heavy = pixels([[20, 60, 120, 255]], 30);
  const all = new Uint8ClampedArray(data.length + heavy.length);
  all.set(data);
  all.set(heavy, data.length);
  const swatches = extractSwatches(all, 3);
  assert.ok(swatches.length >= 2);
  const total = swatches.reduce((s, w) => s + w.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(swatches[0]!.weight >= swatches[1]!.weight);
  assert.equal(extractSwatches(pixels([[0, 0, 0, 0]], 10)).length, 0);
});

test('swatch extraction is deterministic', () => {
  const data = pixels(
    [
      [43, 93, 96, 255],
      [201, 148, 74, 255],
      [15, 39, 41, 255],
      [239, 228, 204, 255],
    ],
    12,
  );
  assert.deepEqual(extractSwatches(data), extractSwatches(data));
});

test('the accent comes from the vivid part of a mostly dark cover', () => {
  const data = pixels(
    [
      [18, 47, 50, 255], // dark teal field
      [201, 148, 74, 255], // gold detail
    ],
    1,
  );
  const cover = new Uint8ClampedArray([
    ...pixels([[18, 47, 50, 255]], 80),
    ...pixels([[201, 148, 74, 255]], 12),
  ]);
  assert.ok(data.length > 0);
  const palette = paletteFromPixels(cover);
  const accent = oklabToOklch(rgbToOklab(hexToRgb(palette.accent)!));
  // Gold is around hue 70 in OKLCH; teal is around 200.
  assert.ok(accent.h > 40 && accent.h < 110, `accent hue ${accent.h}`);
  const deep = oklabToOklch(rgbToOklab(hexToRgb(palette.deep)!));
  assert.ok(deep.h > 150 && deep.h < 250, `deep hue ${deep.h}`);
});

test('every palette keeps text readable on its surfaces', () => {
  const palettes = [
    paletteFromPixels(null),
    paletteFromPixels(pixels([[255, 255, 255, 255]], 50)),
    paletteFromPixels(pixels([[0, 0, 0, 255]], 50)),
    paletteFromPixels(pixels([[255, 230, 0, 255]], 50)),
    paletteFromPixels(pixels([[0, 80, 255, 255]], 50)),
    paletteFromHex('#f44c7f'),
    paletteFromHex('not a color'),
  ];
  for (const p of palettes) {
    assert.ok(
      contrastRatio(p.onDeep, p.deep) >= 7,
      `onDeep/deep ${p.onDeep} ${p.deep}`,
    );
    assert.ok(
      contrastRatio(p.ink, p.paper) >= 7,
      `ink/paper ${p.ink} ${p.paper}`,
    );
    assert.ok(
      contrastRatio(p.inkMuted, p.paper) >= 4.5,
      `inkMuted/paper ${p.inkMuted} ${p.paper}`,
    );
    assert.ok(
      contrastRatio(p.duoInk, p.duo) >= 4.5,
      `duoInk/duo ${p.duoInk} ${p.duo}`,
    );
    assert.ok(contrastRatio(p.duoInk, p.duoLight) >= 4.5, `duoInk/duoLight`);
    for (const value of Object.values(p)) assert.match(value, /^#[0-9a-f]{6}$/);
  }
});

test('a gray cover still gets a usable palette', () => {
  const gray = rgbToOklab({ r: 128, g: 128, b: 128 });
  const palette = buildCardPalette(gray, gray);
  assert.match(palette.deep, /^#[0-9a-f]{6}$/);
  assert.ok(contrastRatio(palette.onDeep, palette.deeper) > 10);
});

test('contrast ratio matches WCAG endpoints', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.01);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
});
