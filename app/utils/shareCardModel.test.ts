import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableShareCardToggles,
  buildShareCardChart,
  buildShareCardModel,
  DEFAULT_SHARE_CARD_TOGGLES,
  formatAuthors,
  formatCount,
  formatDateRange,
  formatPace,
  shareCardFileName,
  shareCardStats,
  type FinishProgressDay,
  type FinishSummary,
} from './shareCardModel.ts';

function day(
  date: string,
  percent: number,
  pagesRead: number | null,
  hasCheckpoint: boolean,
): FinishProgressDay {
  return {
    date,
    percent,
    deltaPercent: 0,
    pages: null,
    pagesRead,
    hasCheckpoint,
  };
}

function summary(overrides: Partial<FinishSummary> = {}): FinishSummary {
  return {
    book: {
      id: 'book-1',
      title: 'The Synthetic Almanac',
      authors: ['Ada Example'],
      series: null,
      pages: 412,
      coverImagePath: 'cover.jpg',
      updatedAt: '2026-11-11T00:00:00.000Z',
    },
    status: 'finished',
    startedAt: '2026-11-03T00:00:00.000Z',
    finishedAt: '2026-11-11T00:00:00.000Z',
    startedDate: '2026-11-03',
    finishedDate: '2026-11-11',
    durationDays: 9,
    pages: 412,
    pagesPerDay: 45.8,
    rating: 9,
    finishYear: 2026,
    yearFinishOrdinal: 12,
    progress: {
      checkpointCount: 3,
      days: [
        day('2026-11-03', 20, 82, true),
        day('2026-11-04', 20, 0, false),
        day('2026-11-05', 60, 165, true),
        day('2026-11-06', 100, 165, true),
      ],
    },
    ...overrides,
  };
}

test('a complete summary shows every stat', () => {
  const model = buildShareCardModel(summary(), DEFAULT_SHARE_CARD_TOGGLES);
  assert.equal(model.eyebrow, 'Finished · November 2026');
  assert.equal(model.monthLabel, 'Nov 2026');
  assert.equal(model.dateRange, 'Nov 3 – Nov 11, 2026');
  assert.equal(model.yearOrdinal, 'Book 12 of 2026');
  assert.equal(model.durationDays, 9);
  assert.equal(model.pages, 412);
  assert.equal(model.pagesPerDay, 45.8);
  assert.equal(model.stars, 4.5);
  assert.ok(model.chart);
  assert.equal(model.chart.unit, 'pages');
  assert.equal(model.chart.bestDay, 165);
  assert.deepEqual(
    shareCardStats(model).map((s) => `${s.value} ${s.unit}`),
    ['9 days', '412 pages', '46 /day', '4.5 ★'],
  );
});

test('a missing start date hides duration, pace, and the chart', () => {
  const model = buildShareCardModel(
    summary({
      startedDate: null,
      startedAt: null,
      durationDays: null,
      pagesPerDay: null,
    }),
    DEFAULT_SHARE_CARD_TOGGLES,
  );
  assert.equal(model.durationDays, null);
  assert.equal(model.pagesPerDay, null);
  assert.equal(model.chart, null);
  assert.equal(model.pages, 412);
  assert.equal(model.dateRange, 'Nov 11, 2026');
  assert.deepEqual(
    shareCardStats(model).map((s) => s.key),
    ['pages', 'rating'],
  );
});

test('a missing page count hides page stats', () => {
  const s = summary({ pages: null, pagesPerDay: null });
  s.book.pages = null;
  s.progress.days = s.progress.days.map((d) => ({
    ...d,
    pagesRead: null,
    deltaPercent: 10,
  }));
  const model = buildShareCardModel(s, DEFAULT_SHARE_CARD_TOGGLES);
  assert.equal(model.pages, null);
  assert.equal(model.pagesPerDay, null);
  assert.equal(model.chart?.unit, 'percent');
  assert.equal(availableShareCardToggles(s).pages, false);
});

test('the chart needs three dated checkpoints', () => {
  const two = summary();
  two.progress = { ...two.progress, checkpointCount: 2 };
  assert.equal(buildShareCardChart(two), null);
  assert.equal(availableShareCardToggles(two).chart, false);
  const single = summary();
  single.progress = {
    checkpointCount: 3,
    days: [day('2026-11-03', 100, 412, true)],
  };
  assert.equal(buildShareCardChart(single), null);
  assert.ok(buildShareCardChart(summary()));
});

test('toggles pare a card down to cover and title', () => {
  const model = buildShareCardModel(summary(), {
    rating: false,
    duration: false,
    pages: false,
    chart: false,
    logo: false,
  });
  assert.deepEqual(shareCardStats(model), []);
  assert.equal(model.chart, null);
  assert.equal(model.stars, null);
  assert.equal(model.dateRange, null);
  assert.equal(model.yearOrdinal, null);
  assert.equal(model.showLogo, false);
  assert.equal(model.title, 'The Synthetic Almanac');
});

test('an unfinished book without dates still builds a model', () => {
  const model = buildShareCardModel(
    summary({
      status: 'reading',
      finishedAt: null,
      finishedDate: null,
      startedDate: null,
      durationDays: null,
      pagesPerDay: null,
      rating: null,
      finishYear: null,
      yearFinishOrdinal: null,
      progress: { checkpointCount: 0, days: [] },
    }),
    DEFAULT_SHARE_CARD_TOGGLES,
  );
  assert.equal(model.eyebrow, 'Finished');
  assert.equal(model.monthLabel, null);
  assert.equal(model.dateRange, null);
  assert.equal(model.stars, null);
});

test('one-day reads use singular units', () => {
  const model = buildShareCardModel(
    summary({ startedDate: '2026-11-11', durationDays: 1, pagesPerDay: 412 }),
    DEFAULT_SHARE_CARD_TOGGLES,
  );
  assert.equal(model.dateRange, 'Nov 11, 2026');
  assert.equal(shareCardStats(model)[0]!.unit, 'day');
});

test('formatters', () => {
  assert.equal(formatAuthors([]), '');
  assert.equal(formatAuthors(['A']), 'A');
  assert.equal(formatAuthors(['A', 'B']), 'A & B');
  assert.equal(formatAuthors(['A', 'B', 'C']), 'A, B & C');
  assert.equal(formatAuthors(['A', 'B', 'C', 'D']), 'A, B & others');
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(formatPace(45.8), '46');
  assert.equal(formatPace(3.25), '3.3');
  assert.equal(
    formatDateRange('2025-12-28', '2026-01-04'),
    'Dec 28, 2025 – Jan 4, 2026',
  );
  assert.equal(formatDateRange('2026-11-03', null), null);
});

test('file names are safe slugs', () => {
  assert.equal(
    shareCardFileName('Les Misérables: Part 1!', 'story'),
    'delb-les-miserables-part-1-story.png',
  );
  assert.equal(shareCardFileName('???', 'square'), 'delb-book-square.png');
});
