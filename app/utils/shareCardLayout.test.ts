import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bucketAmounts,
  chartBars,
  containRect,
  coverRect,
  curvePoints,
  fitText,
  formatSize,
  insetRect,
  safeInsets,
  stackLayout,
  truncate,
  wrapText,
  type MeasureText,
} from './shareCardLayout.ts';

// Every character is 10px wide at "10px", scaled by the font size.
const measure: MeasureText = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
  return [...text].length * size;
};
const at = (size: number) => `500 ${size}px Serif`;

test('formats have the documented sizes', () => {
  assert.deepEqual(formatSize('square'), { width: 1080, height: 1080 });
  assert.deepEqual(formatSize('story'), { width: 1080, height: 1920 });
  assert.deepEqual(formatSize('landscape'), { width: 1200, height: 630 });
});

test('story cards keep generous top and bottom safe zones', () => {
  const story = safeInsets('story');
  const square = safeInsets('square');
  assert.ok(story.top >= 250 && story.bottom >= 250);
  assert.ok(story.top > square.top && story.bottom > square.bottom);
  const area = insetRect(formatSize('story'), story);
  assert.equal(area.y, story.top);
  assert.equal(area.y + area.height, 1920 - story.bottom);
});

test('wrapText fills lines and ends with an ellipsis on overflow', () => {
  assert.deepEqual(wrapText('one two three', 100, at(10), measure, 2), [
    'one two',
    'three',
  ]);
  const lines = wrapText(
    'one two three four five six',
    100,
    at(10),
    measure,
    2,
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'one two');
  assert.ok(lines[1]!.endsWith('…'));
  assert.ok(measure(lines[1]!, at(10)) <= 100);
  assert.deepEqual(wrapText('   ', 100, at(10), measure), []);
});

test('wrapText cuts a single word that is too wide', () => {
  const lines = wrapText('Supercalifragilistic', 60, at(10), measure, 2);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.endsWith('…'));
  assert.ok(measure(lines[0]!, at(10)) <= 60);
});

test('truncate leaves short text alone', () => {
  assert.equal(truncate('short', 100, at(10), measure), 'short');
  assert.equal(truncate('a longer title', 60, at(10), measure), 'a lon…');
});

test('fitText steps the font down until the text fits', () => {
  const fit = fitText('The Cartographer Almanac', 200, at, measure, {
    maxSize: 20,
    minSize: 8,
    maxLines: 2,
  });
  assert.ok(fit.size < 20);
  assert.ok(fit.lines.every((l) => !l.endsWith('…')));
  assert.ok(fit.lines.every((l) => measure(l, at(fit.size)) <= 200));

  const tooLong = fitText('x '.repeat(200), 100, at, measure, {
    maxSize: 20,
    minSize: 10,
    maxLines: 2,
  });
  assert.equal(tooLong.size, 10);
  assert.ok(tooLong.lines[1]!.endsWith('…'));
});

test('containRect and coverRect keep the aspect ratio', () => {
  const box = { x: 0, y: 0, width: 300, height: 300 };
  const inside = containRect(2 / 3, box);
  assert.equal(inside.height, 300);
  assert.equal(inside.width, 200);
  assert.equal(inside.x, 50);
  const covering = coverRect(2 / 3, box);
  assert.equal(covering.width, 300);
  assert.equal(covering.height, 450);
  assert.equal(covering.y, -75);
  // A bad aspect falls back to a book cover's 2:3.
  assert.equal(containRect(0, box).width, 200);
});

test('stackLayout centers the block and shares leftover height', () => {
  const pos = stackLayout(
    [
      { height: 10 },
      { height: 0, gap: 10, flex: { min: 50, max: 1000 } },
      { height: 20, gap: 10 },
    ],
    { y: 0, height: 200 },
  );
  assert.deepEqual(pos[0], { y: 0, height: 10 });
  assert.deepEqual(pos[1], { y: 20, height: 150 });
  assert.deepEqual(pos[2], { y: 180, height: 20 });

  const capped = stackLayout([{ height: 0, flex: { min: 10, max: 40 } }], {
    y: 100,
    height: 200,
  });
  assert.deepEqual(capped[0], { y: 180, height: 40 });
});

const points = (amounts: number[]) =>
  amounts.map((amount, i) => ({
    date: `2026-11-${String(i + 1).padStart(2, '0')}`,
    percent: Math.min(100, (i + 1) * 10),
    amount,
    checkpoint: amount > 0,
  }));

test('bucketAmounts groups long reads into a fixed number of bars', () => {
  assert.deepEqual(bucketAmounts(points([1, 2, 3, 4, 5]), 10), [1, 2, 3, 4, 5]);
  assert.deepEqual(bucketAmounts(points([1, 2, 3, 4, 5]), 2), [6, 9]);
  const year = bucketAmounts(points(new Array(365).fill(1)), 30);
  assert.ok(year.length <= 30 && year.length >= 20, `bars: ${year.length}`);
  assert.equal(
    year.reduce((a, b) => a + b, 0),
    365,
  );
  assert.deepEqual(bucketAmounts([], 5), []);
});

test('chartBars scale to the tallest day and mark it', () => {
  const bars = chartBars(points([10, 0, 40, 20]), {
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  });
  assert.equal(bars.length, 4);
  assert.equal(bars[2]!.height, 50);
  assert.equal(bars[2]!.y, 0);
  assert.equal(bars[2]!.best, true);
  assert.equal(bars[1]!.height, 0);
  assert.equal(bars[0]!.height, 12.5);
  assert.ok(bars.every((b) => b.x >= 0 && b.x + b.width <= 100));
  assert.ok(
    chartBars(points([0, 0]), { x: 0, y: 0, width: 10, height: 10 }).every(
      (b) => !b.best,
    ),
  );
});

test('curvePoints start at zero and end at the last percent', () => {
  const pts = curvePoints(points([1, 1, 1]), {
    x: 0,
    y: 0,
    width: 300,
    height: 100,
  });
  assert.equal(pts.length, 4);
  assert.deepEqual(pts[0], { x: 0, y: 100 });
  assert.deepEqual(pts[3], { x: 300, y: 70 });
  assert.ok(pts.every((p, i) => i === 0 || p.x > pts[i - 1]!.x));
});

test('fitText shrinks when a long word would be cut on an early line', () => {
  // "Cartographer's" is 14 characters; at 20px it needs 280px.
  const fit = fitText("The Cartographer's Almanac", 200, at, measure, {
    maxSize: 20,
    minSize: 8,
    maxLines: 4,
  });
  assert.ok(
    fit.lines.every((l) => !l.endsWith('…')),
    fit.lines.join('|'),
  );
  assert.ok(fit.size <= 14);
});
