'use strict';

/*
 * H1/H2 hardening tests for src/services/ucpWarmHandoff.js. NO live network — the UCP client is a fake and the
 * clock is injected. Covers: the explicit bounded TTL cache (+ negative cache), reachability-drift signal, the
 * error-taxonomy -> clean-null + tagged-reason mapping, product-state edge-case fallbacks, the total-latency
 * budget, and observability emission (counters/latency/drift fire with the right labels). Success behavior is
 * asserted unchanged.
 */

const {
  createWarmHandoffService,
  createTtlCache,
  WARM_HANDOFF_DISPOSITION,
} = require('../src/services/ucpWarmHandoff');
const {
  renderUcpWarmHandoffMetricsPrometheus,
  resetUcpWarmHandoffMetricsForTest,
} = require('../src/observability/ucpWarmHandoffMetrics');

function fakeMetrics() {
  const calls = { outcome: [], latency: [], drift: [] };
  return {
    recordWarmHandoffOutcome: (a) => calls.outcome.push(a),
    observeWarmHandoffLatency: (a) => calls.latency.push(a),
    recordReachabilityDrift: (a) => calls.drift.push(a),
    _calls: calls,
  };
}

function fakeClient(opts = {}) {
  const state = {
    reachable: opts.reachable !== false,
    discoverThrow: opts.discoverThrow || null,
    cart: opts.cart || null,
    cartThrow: opts.cartThrow || null,
    onDiscover: opts.onDiscover || null,
  };
  const calls = { discover: 0, createCart: 0 };
  const client = {
    async discoverEndpoint(origin) {
      calls.discover += 1;
      if (state.onDiscover) state.onDiscover();
      if (state.discoverThrow) throw state.discoverThrow;
      if (state.reachable) return { mcpEndpoint: `${origin}/api/ucp/mcp`, status: 200 };
      return { mcpEndpoint: undefined, status: 404 };
    },
    async createCart(endpoint, args) {
      calls.createCart += 1;
      if (state.cartThrow) throw state.cartThrow;
      if (state.cart) return state.cart;
      return {
        ok: true,
        status: 200,
        response: {
          result: {
            content: [{
              type: 'json',
              json: {
                id: 'gid://shopify/Cart/1',
                continue_url: 'https://brand.myshopify.com/cart/c/1?key=SECRETTAIL',
                line_items: [{ item: { id: args.lineItems[0].item.id, title: 'T' }, quantity: args.lineItems[0].quantity }],
              },
            }],
          },
        },
      };
    },
    extractHandoffUrl(cart) {
      const j = cart && cart.response && cart.response.result && cart.response.result.content
        && cart.response.result.content[0] && cart.response.result.content[0].json;
      return j ? (j.continue_url || null) : (cart && cart.continue_url) || null;
    },
  };
  return { state, calls, client };
}

const GID = 'gid://shopify/ProductVariant/1';

describe('createTtlCache (explicit, bounded, TTL)', () => {
  test('entries expire after their TTL', () => {
    let t = 0;
    const cache = createTtlCache({ now: () => t });
    cache.set('a', 1, 100);
    expect(cache.get('a')).toBe(1);
    t = 99;
    expect(cache.get('a')).toBe(1);
    t = 100;
    expect(cache.get('a')).toBeUndefined();
  });

  test('is bounded — oldest entry evicted past maxEntries', () => {
    const cache = createTtlCache({ maxEntries: 2 });
    cache.set('a', 1, 0);
    cache.set('b', 2, 0);
    cache.set('c', 3, 0);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined(); // evicted
    expect(cache.get('c')).toBe(3);
  });
});

describe('endpoint discovery cache — positive TTL + negative TTL', () => {
  test('a reachable endpoint is cached across calls (discovered once), re-discovered after positive TTL', async () => {
    let t = 0;
    const fc = fakeClient();
    const svc = createWarmHandoffService({ client: fc.client, metrics: fakeMetrics(), now: () => t, endpointTtlMs: 1000, negativeTtlMs: 100 });
    await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: GID });
    await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: GID });
    expect(fc.calls.discover).toBe(1); // cached
    t = 1000; // positive TTL expired
    await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: GID });
    expect(fc.calls.discover).toBe(2); // re-discovered
  });

  test('an UNREACHABLE domain is negative-cached (short TTL) — not re-hammered until it expires', async () => {
    let t = 0;
    const fc = fakeClient({ reachable: false });
    const svc = createWarmHandoffService({ client: fc.client, metrics: fakeMetrics(), now: () => t, endpointTtlMs: 1000, negativeTtlMs: 100 });
    await svc.resolveWarmHandoff({ brandDomain: 'nope.example', variantGid: GID });
    await svc.resolveWarmHandoff({ brandDomain: 'nope.example', variantGid: GID });
    expect(fc.calls.discover).toBe(1); // negative-cached; not re-hammered
    t = 100; // negative TTL (shorter) expired
    await svc.resolveWarmHandoff({ brandDomain: 'nope.example', variantGid: GID });
    expect(fc.calls.discover).toBe(2);
  });
});

describe('reachability drift signal', () => {
  test('a previously-reachable domain that starts failing discovery emits a drift metric', async () => {
    let t = 0;
    const fc = fakeClient({ reachable: true });
    const metrics = fakeMetrics();
    const logs = [];
    const logger = { warn: (o) => logs.push(o), info: () => {} };
    const svc = createWarmHandoffService({ client: fc.client, metrics, logger, now: () => t, endpointTtlMs: 1000, negativeTtlMs: 100 });
    await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: GID }); // reachable -> everReachable
    expect(metrics._calls.drift).toHaveLength(0);
    // Expire the positive cache, flip the brand to unreachable, re-resolve -> drift.
    t = 1000;
    fc.state.reachable = false;
    await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: GID });
    expect(metrics._calls.drift).toEqual([{ brandDomain: 'cosrx.com' }]);
    expect(logs.some((l) => l.event === 'ucp_warm_handoff_reachability_drift')).toBe(true);
  });
});

describe('error taxonomy -> clean null + tagged reason (cold-redirect fallback)', () => {
  async function reasonFor(clientOpts, params = {}) {
    const metrics = fakeMetrics();
    const fc = fakeClient(clientOpts);
    const svc = createWarmHandoffService({ client: fc.client, metrics, now: () => 0 });
    const r = await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: GID, ...params });
    return { r, metrics, fc };
  }

  test('not UCP-reachable => null, reason not_ucp_reachable', async () => {
    const { r, metrics, fc } = await reasonFor({ reachable: false });
    expect(r).toBeNull();
    expect(metrics._calls.outcome).toEqual([{ outcome: 'fallback', reason: 'not_ucp_reachable', brandDomain: 'cosrx.com' }]);
    expect(fc.calls.createCart).toBe(0);
  });

  test('discovery throws (network) => null, reason profile_unreachable', async () => {
    const { r, metrics } = await reasonFor({ discoverThrow: new Error('ECONNRESET') });
    expect(r).toBeNull();
    expect(metrics._calls.outcome[0]).toMatchObject({ outcome: 'fallback', reason: 'profile_unreachable' });
  });

  test('createCart throws => null, reason tool_error', async () => {
    const { r, metrics } = await reasonFor({ cartThrow: new Error('socket hang up') });
    expect(r).toBeNull();
    expect(metrics._calls.outcome[0]).toMatchObject({ outcome: 'fallback', reason: 'tool_error' });
  });

  test('out-of-stock create_cart error => null, reason out_of_stock (never a broken cart)', async () => {
    const { r, metrics } = await reasonFor({ cart: { ok: false, status: 422, error: { code: 422, message: 'The product is out of stock' } } });
    expect(r).toBeNull();
    expect(metrics._calls.outcome[0]).toMatchObject({ outcome: 'fallback', reason: 'out_of_stock' });
  });

  test('invalid-variant create_cart error => null, reason variant_invalid', async () => {
    const { r, metrics } = await reasonFor({ cart: { ok: false, status: 404, error: { code: 404, message: 'Variant not found' } } });
    expect(r).toBeNull();
    expect(metrics._calls.outcome[0]).toMatchObject({ outcome: 'fallback', reason: 'variant_invalid' });
  });

  test('cart built but no continue_url => null, reason no_continue_url', async () => {
    const { r, metrics } = await reasonFor({ cart: { ok: true, status: 200, response: { result: { content: [{ type: 'json', json: { id: 'c1' } }] } } } });
    expect(r).toBeNull();
    expect(metrics._calls.outcome[0]).toMatchObject({ outcome: 'fallback', reason: 'no_continue_url' });
  });

  test('missing inputs => null, reason invalid_input', async () => {
    const metrics = fakeMetrics();
    const fc = fakeClient();
    const svc = createWarmHandoffService({ client: fc.client, metrics, now: () => 0 });
    expect(await svc.resolveWarmHandoff({ variantGid: GID })).toBeNull();
    expect(metrics._calls.outcome[0]).toMatchObject({ outcome: 'fallback', reason: 'invalid_input' });
  });
});

describe('success path is unchanged + records success metrics', () => {
  test('returns a warm_handoff and records outcome=success/latency (no URL key material in the metric)', async () => {
    const metrics = fakeMetrics();
    const fc = fakeClient();
    const svc = createWarmHandoffService({ client: fc.client, metrics, now: () => 0 });
    const r = await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: GID });
    expect(r).not.toBeNull();
    expect(r.disposition).toBe(WARM_HANDOFF_DISPOSITION);
    expect(r.continue_url).toBe('https://brand.myshopify.com/cart/c/1?key=SECRETTAIL');
    expect(metrics._calls.outcome).toEqual([{ outcome: 'success', reason: 'ok', brandDomain: 'cosrx.com' }]);
    expect(metrics._calls.latency[0]).toMatchObject({ outcome: 'success' });
    // The metric label set carries no cart key material (brand host only).
    expect(JSON.stringify(metrics._calls.outcome)).not.toContain('SECRETTAIL');
  });
});

describe('total-latency budget guards a slow brand', () => {
  test('when discovery burns the budget, the lane bails to cold redirect (reason timeout) without a cart call', async () => {
    let t = 0;
    // Discovery "takes" 10s of wall-clock (advances the injected clock) — over the 5s budget.
    const fc = fakeClient({ onDiscover: () => { t += 10000; } });
    const metrics = fakeMetrics();
    const svc = createWarmHandoffService({ client: fc.client, metrics, now: () => t, totalBudgetMs: 5000 });
    const r = await svc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: GID });
    expect(r).toBeNull();
    expect(fc.calls.createCart).toBe(0); // never attempted a cart after the budget was blown
    expect(metrics._calls.outcome[0]).toMatchObject({ outcome: 'fallback', reason: 'timeout' });
  });
});

describe('observability — real metrics module render', () => {
  beforeEach(() => resetUcpWarmHandoffMetricsForTest());

  test('a success + a fallback render the expected Prometheus counters/histogram', async () => {
    // Success against a reachable brand (uses the DEFAULT real metrics sink).
    const okSvc = createWarmHandoffService({ client: fakeClient().client, now: () => 0 });
    await okSvc.resolveWarmHandoff({ brandDomain: 'cosrx.com', variantGid: GID });
    // Fallback against an unreachable brand.
    const badSvc = createWarmHandoffService({ client: fakeClient({ reachable: false }).client, now: () => 0 });
    await badSvc.resolveWarmHandoff({ brandDomain: 'nope.example', variantGid: GID });

    const text = renderUcpWarmHandoffMetricsPrometheus();
    expect(text).toContain('ucp_warm_handoff_total{brand_domain="cosrx_com",outcome="success",reason="ok"} 1');
    expect(text).toContain('ucp_warm_handoff_total{brand_domain="nope_example",outcome="fallback",reason="not_ucp_reachable"} 1');
    expect(text).toContain('# TYPE ucp_warm_handoff_latency_ms histogram');
    expect(text).toContain('ucp_warm_handoff_latency_ms_count{outcome="success"} 1');
    expect(text).toContain('# TYPE ucp_warm_handoff_reachability_drift_total counter');
  });
});
