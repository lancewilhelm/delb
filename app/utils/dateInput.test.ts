import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCompleteDate } from './dateInput';

test('a complete date with a four-digit year is accepted', () => {
  assert.equal(isCompleteDate('2024-05-14'), true);
  assert.equal(isCompleteDate('2024-02-29'), true);
});

test('dates that browsers report while a year is typed are rejected', () => {
  for (const value of ['0002-05-14', '0020-05-14', '0202-05-14']) {
    assert.equal(isCompleteDate(value), false, value);
  }
});

test('empty, malformed, and impossible dates are rejected', () => {
  for (const value of ['', '2024-5-14', '2024-13-01', '2023-02-29', 'x']) {
    assert.equal(isCompleteDate(value), false, value);
  }
});
