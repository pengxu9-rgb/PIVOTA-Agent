const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/weatherAdapter');

function diffDays(start, end) {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return NaN;
  return Math.floor((endMs - startMs) / 86400000);
}

test('clampDateRange defaults to 5-day inclusive window when dates are missing', () => {
  const { start, end } = __internal.clampDateRange();
  assert.equal(diffDays(start, end), 4);
});

test('clampDateRange uses 5-day inclusive window when only start_date is provided', () => {
  const { start, end } = __internal.clampDateRange('2026-03-01', '');
  assert.equal(start, '2026-03-01');
  assert.equal(end, '2026-03-05');
});

test('clampDateRange caps output to max 7-day inclusive window', () => {
  const { start, end } = __internal.clampDateRange('2026-03-01', '2026-03-20');
  assert.equal(start, '2026-03-01');
  assert.equal(end, '2026-03-07');
  assert.equal(diffDays(start, end), 6);
});
