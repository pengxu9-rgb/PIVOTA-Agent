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

// Everything above drives a FAKE clock, which cannot tell a working instrument from a frozen one:
// with `now = () => 0` every phase reports 0, the whole latency lands in `unattributed`, the sum
// identity still holds and all keys are present. This drives the REAL clock through the REAL build
// with one deliberately slow provider, and asserts the time lands in the phase that did the work -
// which also pins the phase LABELS, since swapping two of them moves the milliseconds.
describe('phases measure real elapsed time, in the phase that spent it', () => {
  const { getDiscoveryFeed } = require('../src/services/discoveryFeed');
  const { getLastDiscoverySnapshot } = require('../src/observability/discoveryMetrics');

  test('a slow recall provider shows up in recall, not elsewhere', async () => {
    for (const key of ['DISCOVERY_PRODUCTS_SEARCH_BASE_URL', 'PIVOTA_BACKEND_BASE_URL', 'PIVOTA_API_BASE',
      'DISCOVERY_PRODUCTS_SEARCH_API_KEY', 'PIVOTA_BACKEND_AGENT_API_KEY', 'PIVOTA_API_KEY', 'DATABASE_URL']) {
      delete process.env[key];
    }
    const SLOW_MS = 120;
    const slowExternal = jest.fn(async (args = {}) => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      const queries = args.queries || [args.request?.query?.text].filter(Boolean);
      return Array.from({ length: 12 }, (_, idx) => ({
        merchant_id: 'external_seed',
        product_id: `slow_${idx + 1}`,
        title: `Slow Probe ${idx + 1}`,
        description: '',
        brand: `Slow Brand ${idx + 1}`,
        category: 'Lip Balm',
        product_type: 'Lip Balm',
        price: 10 + idx,
        currency: 'USD',
        inventory_quantity: 10,
        url: `https://shop.example.com/slow-${idx}`,
        status: 'active',
        observed_queries: queries,
      }));
    });

    await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: { text: 'lip balm' },
        context: { auth_state: 'anonymous', recent_views: [], recent_queries: [], locale: 'en-US' },
      },
      { providerOverrides: { internal_catalog: jest.fn(async () => []), external_seeds: slowExternal } },
    );

    expect(slowExternal).toHaveBeenCalled();
    const phases = getLastDiscoverySnapshot('browse_products').phase_ms;
    // The sleep happened inside the recall window and nowhere else.
    expect(phases.recall).toBeGreaterThanOrEqual(SLOW_MS - 20);
    for (const [name, value] of Object.entries(phases)) {
      if (name === 'recall') continue;
      expect(value).toBeLessThan(SLOW_MS - 20);
    }
  });
});

// The regression guard for the fix this file exists to protect. Swapping the two marks around the
// stable-count await - no label change, no removal - reinstates the original defect (the wait
// charged to `select`) and every other test still passes. So the boundary itself is pinned here,
// the same way the recall boundary is: make the count slow, assert the time lands in its phase.
describe('the stable browse count wait is its own phase', () => {
  const SLOW_MS = 150;

  afterEach(() => {
    jest.dontMock('../src/db');
    jest.resetModules();
    delete process.env.DATABASE_URL;
  });

  test('a slow count query shows up in stable_count_wait, not in select', async () => {
    for (const key of ['DISCOVERY_PRODUCTS_SEARCH_BASE_URL', 'PIVOTA_BACKEND_BASE_URL', 'PIVOTA_API_BASE',
      'DISCOVERY_PRODUCTS_SEARCH_API_KEY', 'PIVOTA_BACKEND_AGENT_API_KEY', 'PIVOTA_API_KEY']) {
      delete process.env[key];
    }
    // countStableBrowseCatalogTotal returns null without a DSN, so the branch needs one set.
    process.env.DATABASE_URL = 'postgres://phase-probe';
    jest.resetModules();
    jest.doMock('../src/db', () => ({
      query: async (sql) => {
        if (/count\(/i.test(String(sql || ''))) {
          await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
          return { rows: [{ total: 42 }] };
        }
        return { rows: [] };
      },
      withClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    }));

    const { getDiscoveryFeed: freshFeed } = require('../src/services/discoveryFeed');
    const { getLastDiscoverySnapshot: freshSnapshot } = require('../src/observability/discoveryMetrics');

    await freshFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        context: { auth_state: 'anonymous', recent_views: [], recent_queries: [], locale: 'en-US' },
      },
      { providerOverrides: { internal_catalog: jest.fn(async () => []), external_seeds: jest.fn(async () => []) } },
    );

    const phases = freshSnapshot('browse_products').phase_ms;
    expect(phases.stable_count_wait).toBeGreaterThanOrEqual(SLOW_MS - 30);
    expect(phases.select).toBeLessThan(SLOW_MS - 30);
  });
});
