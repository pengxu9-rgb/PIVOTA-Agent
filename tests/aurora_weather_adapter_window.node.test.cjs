const test = require('node:test');
const assert = require('node:assert/strict');

const { climateFallback, __internal } = require('../src/auroraBff/weatherAdapter');

const { clampDateRange } = __internal;

function diffDays(start, end) {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  return Math.floor((endMs - startMs) / 86400000);
}

test('weather adapter clampDateRange defaults to 5-day window', () => {
  const out = clampDateRange();
  assert.equal(typeof out.start, 'string');
  assert.equal(typeof out.end, 'string');
  assert.equal(diffDays(out.start, out.end), 4);
});

test('weather adapter clampDateRange caps any range to max 7 days', () => {
  const out = clampDateRange('2026-03-01', '2026-03-20');
  assert.equal(out.start, '2026-03-01');
  assert.equal(out.end, '2026-03-07');
  assert.equal(diffDays(out.start, out.end), 6);
});

test('weather adapter climate fallback uses 5-day default summary/window', () => {
  const out = climateFallback({
    destination: 'Paris',
    reason: 'geocode_failed',
    userLocale: 'EN',
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'climate_fallback');
  assert.equal(out.summary.days_count, 5);
  assert.ok(Array.isArray(out.forecast_window));
  assert.equal(out.forecast_window.length, 5);
  assert.equal(out.days_covered, 5);
});

test('weather adapter climate fallback respects 7-day hard cap', () => {
  const out = climateFallback({
    destination: 'Paris',
    startDate: '2026-03-01',
    endDate: '2026-03-28',
    reason: 'geocode_failed',
    userLocale: 'EN',
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'climate_fallback');
  assert.equal(out.date_range.start, '2026-03-01');
  assert.equal(out.date_range.end, '2026-03-07');
  assert.ok(Array.isArray(out.forecast_window));
  assert.equal(out.forecast_window.length, 7);
  assert.equal(out.days_covered, 7);
});
