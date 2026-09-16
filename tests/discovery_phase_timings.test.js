const { _internals } = require('../src/services/discoveryFeed');

const { createDiscoveryPhaseTimer } = _internals;

// A fake clock, because the property under test is arithmetic: the phases must add up to the
// total the build reports. Against a real clock that assertion either flakes or is vacuous.
const clockFrom = (times) => {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

describe('discovery phase timings', () => {
  test('phases partition the wall clock, with the remainder named', () => {
    // start=0, setup ends 10, recall ends 810, dedupe 830, select 900, assemble 940, hydrate 1000
    const timer = createDiscoveryPhaseTimer(clockFrom([0, 10, 810, 830, 900, 940, 1000]));
    for (const phase of ['setup', 'recall', 'identity_dedupe', 'select', 'assemble', 'hydrate']) {
      timer.mark(phase);
    }
    const summary = timer.summary(1000);
    expect(summary).toEqual({
      setup: 10,
      recall: 800,
      identity_dedupe: 20,
      select: 70,
      assemble: 40,
      hydrate: 60,
      unattributed: 0,
    });
    const attributed = Object.entries(summary)
      .filter(([name]) => name !== 'unattributed')
      .reduce((sum, [, value]) => sum + value, 0);
    expect(attributed + summary.unattributed).toBe(1000);
  });

  test('time the marks do not cover is reported, not swallowed', () => {
    // The build spent 1000ms; the marks only account for 300. An instrument that hides the
    // 700ms it cannot explain is worse than no instrument - that is the number worth chasing.
    const timer = createDiscoveryPhaseTimer(clockFrom([0, 100, 300]));
    timer.mark('setup');
    timer.mark('recall');
    expect(timer.summary(1000)).toEqual({ setup: 100, recall: 200, unattributed: 700 });
  });

  test('a repeated mark accumulates rather than overwriting', () => {
    // recall runs twice on the brand-fallback path; the second visit must add to the first,
    // or the phase silently under-reports exactly when the build is slowest.
    const timer = createDiscoveryPhaseTimer(clockFrom([0, 50, 90, 140]));
    timer.mark('recall');
    timer.mark('select');
    timer.mark('recall');
    expect(timer.summary(140)).toEqual({ recall: 100, select: 40, unattributed: 0 });
  });

  test('a clock that goes backwards cannot produce a negative phase', () => {
    const timer = createDiscoveryPhaseTimer(clockFrom([100, 40]));
    timer.mark('setup');
    expect(timer.summary(0)).toEqual({ setup: 0, unattributed: 0 });
  });

  test('summary falls back to its own clock when no total is given', () => {
    const timer = createDiscoveryPhaseTimer(clockFrom([0, 30, 80]));
    timer.mark('setup');
    expect(timer.summary()).toEqual({ setup: 30, unattributed: 50 });
  });
});

// The end-to-end half of this - that the BUILD emits these phases - lives in
// tests/discovery_feed_service.test.js, next to the fixture that produces a populated feed.
