import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSpineEditsForSave,
  computeFitDrawRects,
  FULL_CROP_INSETS,
  layoutMiniCover,
  miniCoverFileName,
  suggestOneToThreeCrop,
} from './miniCoverLayout';
import { spineRatioStatus } from '../../shared/spine-artwork';

test('layoutMiniCover produces whole-pixel 50×30mm geometry at 300 and 600 dpi', () => {
  const std = layoutMiniCover({
    pxPerMm: 12,
    bleedMm: 0,
    trimMarks: false,
    orientation: 'ltr',
  });
  assert.equal(std.width, 600);
  assert.equal(std.height, 360);
  assert.deepEqual(std.panels.left, { x: 0, y: 0, w: 240, h: 360 });
  assert.deepEqual(std.panels.spine, { x: 240, y: 0, w: 120, h: 360 });
  assert.deepEqual(std.panels.right, { x: 360, y: 0, w: 240, h: 360 });
  assert.deepEqual(std.folds, [240, 360]);
  assert.deepEqual(std.panels.front, std.panels.right);
  assert.deepEqual(std.panels.back, std.panels.left);

  const high = layoutMiniCover({
    pxPerMm: 24,
    bleedMm: 1,
    trimMarks: true,
    orientation: 'rtl',
  });
  // 50mm + 2*1mm bleed + 2*3mm trim margin = 58mm -> 1392 px
  // 30mm + 2*1mm bleed + 2*3mm trim margin = 38mm -> 912 px
  assert.equal(high.width, 1392);
  assert.equal(high.height, 912);
  assert.equal(high.trimRect.x, 96); // (3 + 1) * 24
  assert.equal(high.trimRect.y, 96);
  assert.equal(high.trimRect.w, 1200);
  assert.equal(high.trimRect.h, 720);
  assert.deepEqual(high.panels.front, high.panels.left);
  assert.deepEqual(high.panels.back, high.panels.right);
});

test('spineRatioStatus classifies fit, slight, mismatch, and very wide spines', () => {
  const exact = spineRatioStatus(256, 768);
  assert.equal(exact?.state, 'fit');
  assert.equal(exact?.recommendedFit, 'stretch');

  const within4 = spineRatioStatus(100, 295);
  assert.equal(within4?.state, 'fit');

  const slight = spineRatioStatus(100, 275);
  assert.equal(slight?.state, 'slight');
  assert.equal(slight?.recommendedFit, 'crop');
  assert.equal(slight?.trimAxis, 'width');
  assert.ok((slight?.trimMm ?? 0) > 0);

  const narrow = spineRatioStatus(100, 500);
  assert.equal(narrow?.state, 'mismatch');
  assert.equal(narrow?.recommendedFit, 'crop');
  assert.equal(narrow?.trimAxis, 'height');

  const square = spineRatioStatus(500, 500);
  assert.equal(square?.state, 'mismatch');
  assert.equal(square?.recommendedFit, 'fit');
});

test('computeFitDrawRects honors crop offset, fit letterboxing, and stretch', () => {
  const target = { x: 10, y: 20, w: 100, h: 300 };

  const centered = computeFitDrawRects({
    sourceWidth: 200,
    sourceHeight: 300,
    target,
    mode: 'crop',
    offset: 0,
  });
  assert.deepEqual(centered.src, { x: 50, y: 0, w: 100, h: 300 });
  assert.deepEqual(centered.dst, target);

  const shiftedRight = computeFitDrawRects({
    sourceWidth: 200,
    sourceHeight: 300,
    target,
    mode: 'crop',
    offset: 1,
  });
  assert.deepEqual(shiftedRight.src, { x: 100, y: 0, w: 100, h: 300 });

  const fitted = computeFitDrawRects({
    sourceWidth: 200,
    sourceHeight: 300,
    target,
    mode: 'fit',
  });
  assert.deepEqual(fitted.src, { x: 0, y: 0, w: 200, h: 300 });
  assert.equal(fitted.dst.w, 100);
  assert.equal(fitted.dst.h, 150);
  assert.equal(fitted.dst.y, 20 + 75);
});

test('suggestOneToThreeCrop centers a 1:3 window on 2:3 generated images and detects solid borders', () => {
  // Plain 2:3 image without pixel analysis -> 25% left, 25% right
  const fallback = suggestOneToThreeCrop(1024, 1536);
  assert.equal(fallback.left, 25);
  assert.equal(fallback.right, 25);
  assert.equal(fallback.top, 0);
  assert.equal(fallback.bottom, 0);

  // Synthetic 60x90 image with white background and a dark 20x60 spine strip at x=[10..29], y=[15..74]
  const w = 60;
  const h = 90;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inSpine = x >= 10 && x < 30 && y >= 15 && y < 75;
      pixels[i] = inSpine ? 25 : 250;
      pixels[i + 1] = inSpine ? 40 : 250;
      pixels[i + 2] = inSpine ? 80 : 250;
      pixels[i + 3] = 255;
    }
  }
  const detected = suggestOneToThreeCrop(w, h, pixels);
  assert.ok(Math.abs(detected.left - 16.7) < 2);
  assert.ok(Math.abs(detected.right - 50) < 2);
  assert.ok(Math.abs(detected.top - 16.7) < 2);
  assert.ok(Math.abs(detected.bottom - 16.7) < 2);
});

test('buildSpineEditsForSave maps crop offset and stretch to SpineEdits', () => {
  const cropped = buildSpineEditsForSave({
    sourceWidth: 200,
    sourceHeight: 300,
    crop: FULL_CROP_INSETS,
    fit: 'crop',
    offset: 0,
  });
  assert.deepEqual(cropped, {
    left: 25,
    right: 25,
    top: 0,
    bottom: 0,
    stretch: false,
  });

  const stretched = buildSpineEditsForSave({
    sourceWidth: 200,
    sourceHeight: 300,
    crop: { left: 10, right: 10, top: 0, bottom: 0 },
    fit: 'stretch',
    offset: 0.5,
  });
  assert.deepEqual(stretched, {
    left: 10,
    right: 10,
    top: 0,
    bottom: 0,
    stretch: true,
  });
});

test('miniCoverFileName formats clean download names', () => {
  assert.equal(
    miniCoverFileName('The Left Hand of Darkness', 'high'),
    'the-left-hand-of-darkness-mini-cover-50x30mm-600dpi.png',
  );
  assert.equal(
    miniCoverFileName('!!!', 'standard'),
    'book-mini-cover-50x30mm-300dpi.png',
  );
});
