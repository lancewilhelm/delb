import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultDashboardSettings,
  displayedCardArt,
  heroArtMode,
  holdPile,
  normalizeDashboardSettings,
  pileLayout,
  resolveCardArt,
  statusSegments,
  wallBookIndex,
  wallDriftPxPerSecond,
  wallSlots,
} from './dashboardArt.ts';

test('wall slots never place a cover next to a copy of itself', () => {
  for (const cols of [5, 7, 9]) {
    for (let n = 4; n <= 15; n++) {
      const ids = Array.from({ length: n }, (_, i) => `b${i}`);
      const slots = wallSlots(ids, cols, cols * 5);
      const at = (row: number, col: number) => slots[row * cols + col];
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < cols; col++) {
          for (const [dr, dc] of [
            [0, 1],
            [1, 0],
            [1, 1],
            [1, -1],
          ] as const) {
            const r2 = row + dr;
            const c2 = col + dc;
            if (r2 >= 5 || c2 < 0 || c2 >= cols) continue;
            assert.notEqual(
              at(row, col),
              at(r2, c2),
              `cols=${cols} n=${n} (${row},${col})`,
            );
          }
        }
      }
    }
  }
  assert.deepEqual(wallSlots(['a', 'b'], 5, 3), ['a', 'b', 'a']);
  assert.deepEqual(wallSlots([], 5, 10), []);
  assert.equal(wallSlots(['a', 'b', 'c'], 2, 2).length, 2);
});

test('card art resolves override, then default, then Auto', () => {
  const settings = defaultDashboardSettings().cardArt;
  assert.equal(resolveCardArt('to_be_read', 'to_be_read', settings), 'fan');
  assert.equal(resolveCardArt('shelf:1', 'shelf', settings), 'fan');
  assert.equal(resolveCardArt('none', 'none', settings), 'pile');
  const custom = {
    default: 'collage' as const,
    overrides: { none: 'wall' as const },
  };
  assert.equal(resolveCardArt('reading', 'reading', custom), 'collage');
  assert.equal(resolveCardArt('none', 'none', custom), 'wall');
});

test('wall falls back to fan below four covers', () => {
  assert.equal(displayedCardArt('wall', 3), 'fan');
  assert.equal(displayedCardArt('wall', 4), 'wall');
  assert.equal(displayedCardArt('pile', 1), 'pile');
});

test('hero art mode follows cover count thresholds', () => {
  assert.equal(heroArtMode(0), 'empty');
  assert.equal(heroArtMode(1), 'spotlight');
  assert.equal(heroArtMode(3), 'spotlight');
  assert.equal(heroArtMode(4), 'wall-small');
  assert.equal(heroArtMode(15), 'wall-small');
  assert.equal(heroArtMode(16), 'wall');
});

test('dashboard settings drop invalid and reset overrides', () => {
  assert.deepEqual(
    normalizeDashboardSettings(undefined),
    defaultDashboardSettings(),
  );
  const normalized = normalizeDashboardSettings({
    showStatusBar: false,
    cardArt: {
      default: 'topple',
      overrides: {
        reading: 'wall',
        none: null,
        dnf: 'queue',
        'shelf:a': 'pile',
      },
    },
  });
  assert.equal(normalized.showStatusBar, false);
  assert.equal(
    normalized.libraryArt,
    'wall',
    'unknown library art falls back to Wall',
  );
  assert.equal(
    normalizeDashboardSettings({ libraryArt: 'pile' }).libraryArt,
    'pile',
  );
  assert.equal(normalized.cardArt.default, 'auto');
  assert.deepEqual(normalized.cardArt.overrides, {
    reading: 'wall',
    'shelf:a': 'pile',
  });
});

test('pile layout is random per list but stable for the same list', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(pileLayout(ids, 'none'), pileLayout(ids, 'none'));
  assert.notDeepEqual(pileLayout(ids, 'none'), pileLayout(ids, 'shelf:x'));
  for (const placement of pileLayout(ids, 'none')) {
    assert.ok(placement.x >= -0.03 && placement.x <= 0.7);
    assert.ok(placement.y >= 0.12 && placement.y <= 0.53);
    assert.ok(Math.abs(placement.r) <= 22);
  }
  // A region keeps a wide card's pile to the right of its text.
  const region = { x0: 0.45, x1: 1, y0: 0, y1: 1 };
  for (const placement of pileLayout(ids, 'all', {
    aspect: 3,
    coverHeight: 0.4,
    region,
  })) {
    assert.ok(placement.x >= 0.42 && placement.x <= 1.03 - (0.4 * (2 / 3)) / 3);
    assert.ok(placement.y >= 0.02 && placement.y <= 1 - 0.4 * 0.95);
  }
});

test('a pile keeps its books until its list changes size', () => {
  const shown = { count: 30, random: true, books: ['a', 'b'] };
  const fresh = { count: 30, random: true, books: ['c', 'd'] };
  assert.equal(holdPile(undefined, fresh), fresh, 'the first sample is used');
  assert.equal(holdPile(shown, fresh), shown, 'a refresh keeps the books');
  const grown = { ...fresh, count: 31 };
  assert.equal(holdPile(shown, grown), grown, 'a changed list re-samples');
  const fallback = { count: 30, random: false, books: ['a', 'b'] };
  assert.equal(
    holdPile(fallback, fresh),
    fresh,
    'a sample replaces a fallback',
  );
  assert.equal(
    holdPile(shown, fallback),
    shown,
    'a fallback never replaces a sample',
  );
});

test('status segments skip empty statuses', () => {
  const segments = statusSegments({
    total: 4,
    reading: 1,
    to_be_read: 3,
    finished: 0,
    dnf: 0,
    none: 0,
  });
  assert.deepEqual(
    segments.map((s) => s.key),
    ['reading', 'to_be_read'],
  );
  assert.equal(segments[1]!.percent, 75);
  assert.deepEqual(
    statusSegments({
      total: 0,
      reading: 0,
      to_be_read: 0,
      finished: 0,
      dnf: 0,
      none: 0,
    }),
    [],
  );
});

test('drifting wall rows never place a cover next to a copy of itself', () => {
  const clashes = (cols: number, count: number, strided: boolean) => {
    for (let row = 0; row < 60; row++) {
      for (let col = 0; col < cols; col++) {
        const here = wallBookIndex(row, col, cols, count, strided);
        for (const [dr, dc] of [
          [0, 1],
          [1, 0],
          [1, 1],
          [1, -1],
        ] as const) {
          const c2 = col + dc;
          if (c2 < 0 || c2 >= cols) continue;
          if (here === wallBookIndex(row + dr, c2, cols, count, strided))
            return `cols=${cols} n=${count} row=${row} col=${col}`;
        }
      }
    }
    return null;
  };
  // Small libraries use the stride; larger ones run in order and wrap.
  for (let n = 4; n <= 15; n++) assert.equal(clashes(7, n, true), null);
  for (let n = 11; n <= 120; n++) assert.equal(clashes(9, n, false), null);
  // Reading order matches the static wall's first rows.
  assert.equal(wallBookIndex(1, 2, 9, 45, false), 11);
  assert.equal(wallBookIndex(5, 0, 9, 45, false), 0, 'wraps to the newest');
});

test('wall motion defaults off and drops unknown directions', () => {
  assert.equal(normalizeDashboardSettings({}).wallMotion, 'off');
  assert.equal(
    normalizeDashboardSettings({ wallMotion: 'up' }).wallMotion,
    'up',
  );
  assert.equal(
    normalizeDashboardSettings({ wallMotion: 'sideways' }).wallMotion,
    'off',
  );
});

test('drift speed is a 1–10 level that defaults to 9 px/s', () => {
  assert.equal(normalizeDashboardSettings({}).wallDriftSpeed, 3);
  assert.equal(wallDriftPxPerSecond(3), 9);
  assert.equal(
    normalizeDashboardSettings({ wallDriftSpeed: 7.4 }).wallDriftSpeed,
    7,
  );
  assert.equal(
    normalizeDashboardSettings({ wallDriftSpeed: 99 }).wallDriftSpeed,
    10,
  );
  assert.equal(
    normalizeDashboardSettings({ wallDriftSpeed: 0 }).wallDriftSpeed,
    1,
  );
  assert.equal(
    normalizeDashboardSettings({ wallDriftSpeed: 'fast' }).wallDriftSpeed,
    3,
  );
  assert.equal(wallDriftPxPerSecond(10), 30);
});
